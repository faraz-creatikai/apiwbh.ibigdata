import crypto from "crypto";
import prisma from "../../config/prismaClient.js";
import { getDriveClientForAdmin } from "../google/googleDriveClient.js";
import {
  qdrant,
  COLLECTION_NAME,
  ensureQdrantCollection,
  deleteDocumentVectors,
} from "./qdrantClient.js";
import { extractTextFromBuffer } from "./extractText.js";
import { chunkText } from "./chunker.js";
import { generateEmbedding } from "./embedder.js";
import { fetchDocumentContext } from "./providers/documentProvider.js";
import { fetchCustomerContext } from "./providers/customerProvider.js";

import { getDynamicAIContext } from "../../config/aiClientFactory.js";
import { executeDynamicPrompt, safeJsonParse } from "../../ai/agent.js";

/**
 * Unchanged: Downloads a CustomerDocument from Google Drive, chunks it,
 * embeds it locally, and stores vectors in Qdrant Cloud.
 */
export async function indexDocument(documentId) {
  const doc = await prisma.customerDocument.findUnique({
    where: { id: documentId },
  });
  if (!doc) throw new Error("Document not found");

  await prisma.customerDocument.update({
    where: { id: doc.id },
    data: { ragStatus: "PROCESSING" },
  });

  try {
    await ensureQdrantCollection();

    const { drive } = await getDriveClientForAdmin(doc.uploadedById);
    const driveRes = await drive.files.get(
      { fileId: doc.driveFileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const buffer = Buffer.from(driveRes.data);

    const rawText = await extractTextFromBuffer(buffer, doc.mimeType, doc.fileName);
    const chunks = chunkText(rawText, 800, 150);

    if (chunks.length === 0) {
      throw new Error("No readable text found in document");
    }

    const points = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = await generateEmbedding(chunks[i]);
      points.push({
        id: crypto.randomUUID(),
        vector,
        payload: {
          documentId: doc.id,
          customerId: doc.customerId || null,
          category: doc.category || "General",
          title: doc.title || doc.fileName,
          fileName: doc.fileName,
          chunkIndex: i,
          content: chunks[i],
        },
      });
    }

    await deleteDocumentVectors(doc.id);
    await qdrant.upsert(COLLECTION_NAME, { wait: true, points });

    await prisma.customerDocument.update({
      where: { id: doc.id },
      data: { ragStatus: "INDEXED" },
    });

    return { success: true, chunksIndexed: points.length };
  } catch (err) {
    console.error(`[RAG Index Error] Doc ${doc.id}:`, err.message);
    await prisma.customerDocument.update({
      where: { id: doc.id },
      data: { ragStatus: "FAILED" },
    });
    throw err;
  }
}

/**
 * Step A: Lightweight Intent & Structured Filter Extractor.
 * Decides whether to query Qdrant documents, MySQL Customer table, or both.
 */
async function planRetrieval({ client, model, provider, query, customerId, category }) {
  // Fast path if category is explicitly selected by the user
  if (category) {
    return {
      needDocs: true,
      needCustomers: Boolean(customerId),
      customerFilters: {},
    };
  }

  const routerPrompt = `You are a CRM query router. Decide which data sources are needed to answer the user's question and extract structured database filters if customers/leads are mentioned.

Available sources:
1. "needDocs": true if the answer might be inside uploaded PDFs, agreements, KYC, brochures, invoices, quotes, notes, or general knowledge documents.
2. "needCustomers": true if the user asks about leads, customers, phone numbers, cities, locations, budgets/prices, campaigns, lead temperature (hot/warm/cold), deal status, or counts.

Return ONLY a single valid JSON object:
{
  "needDocs": true,
  "needCustomers": true,
  "customerFilters": {
    "keyword": string | null,
    "city": string | null,
    "location": string | null,
    "campaign": string | null,
    "leadTemperature": "hot" | "warm" | "cold" | null,
    "customerType": string | null,
    "dealClosed": boolean | null,
    "isFavourite": boolean | null,
    "minPrice": number | null,
    "maxPrice": number | null
  }
}

Context:
- Specific Customer Pre-Selected in UI: ${customerId ? "YES" : "NO"}
- User Question: "${query}"`;

  try {
    const raw = await executeDynamicPrompt(client, model, provider, routerPrompt);
    const parsed = safeJsonParse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        needDocs: parsed.needDocs !== false,
        needCustomers: Boolean(customerId) || Boolean(parsed.needCustomers),
        customerFilters: parsed.customerFilters || {},
      };
    }
  } catch (err) {
    console.warn("[RAG Router Fallback]:", err.message);
  }

  // Safe fallback: query both
  return {
    needDocs: true,
    needCustomers: true,
    customerFilters: { keyword: query },
  };
}

/**
 * Step B: Unified Hybrid CRM + Knowledge Base Chatbot Entry Point.
 */
export async function askKnowledgeBase({
  admin,
  query,
  customerId,
  category,
  history = [],
}) {
  const { client, model, provider } = await getDynamicAIContext(
    "GEMINI",
    "models/gemini-2.5-flash-lite"
  );

  // 1. Route intent & extract structured filters
  const plan = await planRetrieval({
    client,
    model,
    provider,
    query,
    customerId,
    category,
  });

  // 2. Execute enabled context providers in parallel
// 2A. Fetch matching customers first so their IDs can scope document search
  const customerResult = plan.needCustomers
    ? await fetchCustomerContext({
        admin,
        customerId,
        filters: plan.customerFilters,
        limit: 15,
      })
    : { totalMatching: 0, customers: [] };

  const customers = customerResult.customers || [];

  // If no customer was pre-selected in UI, pass matched customer IDs (when narrow, <= 5)
  const inferredCustomerIds =
    !customerId && customers.length > 0 && customers.length <= 5
      ? customers.map((c) => c.id)
      : [];

  // 2B. Fetch relevant document chunks
  const docMatches = plan.needDocs
    ? await fetchDocumentContext({
        admin,
        query,
        customerId,
        customerIds: inferredCustomerIds,
        category,
        topK: 5,
      })
    : [];

  if (docMatches.length === 0 && customers.length === 0) {
    return {
      answer:
        "I couldn't find any matching customer records or indexed documents for your question.",
      confidence: "low",
      sources: [],
      matchedCustomers: [],
    };
  }

  // 3. Build structured + unstructured context sections
  const sections = [];

  if (customers.length > 0) {
    const formattedCustomers = customers.map((c) => ({
      id: c.id,
      name: c.customerName,
      phone: c.ContactNumber,
      email: c.Email || undefined,
      city: c.City || undefined,
      location: [c.Location, c.SubLocation].filter(Boolean).join(", ") || undefined,
      area: c.Area || undefined,
      address: c.Adderess || undefined,
      campaign: c.Campaign || undefined,
      type: [c.CustomerType, c.CustomerSubType].filter(Boolean).join(" / ") || undefined,
      leadType: c.LeadType || undefined,
      temperature: c.LeadTemperature || undefined,
      price: c.Price || c.PriceNumber || undefined,
      facilities: c.Facillities || undefined,
      dealClosed: c.DealClosed,
      favourite: c.isFavourite,
      date: c.CustomerDate || undefined,
      description: c.Description || undefined,
      other: c.Other || undefined,
      customFields:
        c.CustomerFields && Object.keys(c.CustomerFields).length > 0
          ? c.CustomerFields
          : undefined,
      assignedTo: c.AssignTo?.map((a) => a.name).join(", ") || undefined,
      counts: c._count,
    }));

    sections.push(
      `CRM CUSTOMER DATABASE RECORDS (Total matching: ${customerResult.totalMatching}, showing ${customers.length}):\n${JSON.stringify(
        formattedCustomers,
        null,
        2
      )}`
    );
  }

  if (docMatches.length > 0) {
    const docBlock = docMatches
      .map(
        (m, idx) =>
          `[Doc ${idx + 1}: "${m.document.title}" | Category: ${m.document.category}${
            m.customerName ? ` | Customer: ${m.customerName}` : ""
          }]\n${m.content}`
      )
      .join("\n\n---\n\n");

    sections.push(`INDEXED KNOWLEDGE BASE DOCUMENT EXCERPTS:\n${docBlock}`);
  }

  const recentHistory = Array.isArray(history)
    ? history
        .slice(-6)
        .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
        .join("\n")
    : "";

  const promptText = `You are an intelligent CRM Assistant with access to live CRM Customer Database records and uploaded Knowledge Base documents.

Rules:
- Answer accurately using ONLY the provided CRM records and document excerpts.
- When listing customers, include key details like Name, Phone, City/Location, Budget/Price, or Temperature when relevant.
- If the data does not contain the answer, state that clearly instead of guessing.
- Keep responses clear, well-structured, and concise.

Respond with a single valid JSON object matching this exact schema:
{
  "answer": "your helpful response (markdown bullet points allowed inside this string)",
  "confidence": "high" | "medium" | "low"
}

${recentHistory ? `RECENT CONVERSATION:\n${recentHistory}\n\n` : ""}CONTEXT DATA:
${sections.join("\n\n========================================\n\n")}

USER QUESTION:
${query}`;

  const raw = await executeDynamicPrompt(client, model, provider, promptText);
  const parsed = safeJsonParse(raw);

  // Merge matched customers from DB search + customers referenced by matched docs
  const customerMap = new Map();
  for (const c of customers) {
    customerMap.set(c.id, {
      id: c.id,
      customerName: c.customerName,
      ContactNumber: c.ContactNumber,
      City: c.City || "",
      LeadTemperature: c.LeadTemperature || "",
    });
  }
  for (const m of docMatches) {
    if (m.customerId && m.customerName && !customerMap.has(m.customerId)) {
      customerMap.set(m.customerId, {
        id: m.customerId,
        customerName: m.customerName,
        ContactNumber: "",
        City: "",
        LeadTemperature: "",
      });
    }
  }

  return {
    answer: parsed?.answer || "Unable to generate a response.",
    confidence: parsed?.confidence || "low",
    sources: docMatches.map((m) => ({
      documentId: m.document.id,
      title: m.document.title,
      category: m.document.category,
      customerId: m.customerId,
      customerName: m.customerName,
      score: Number(m.score.toFixed(3)),
    })),
    matchedCustomers: Array.from(customerMap.values()),
  };
}