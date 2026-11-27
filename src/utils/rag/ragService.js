import crypto from "crypto";
import prisma from "../../config/prismaClient.js";
import { getDriveClientForAdmin } from "../google/googleDriveClient.js";
import { qdrant, COLLECTION_NAME, ensureQdrantCollection, deleteDocumentVectors } from "./qdrantClient.js";
import { extractTextFromBuffer } from "./extractText.js";
import { chunkText } from "./chunker.js";
import { generateEmbedding } from "./embedder.js";
import { getDynamicAIContext } from "../aiClientFactory.js";
import { executeDynamicPrompt, safeJsonParse } from "../aiHelpers.js"; // <-- update to your actual file path

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

    // Clear old vectors first, then insert fresh ones
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

export async function retrieveRelevantChunks({
  query,
  customerId,
  category,
  topK = 5,
  minScore = 0.25,
}) {
  await ensureQdrantCollection();
  const queryVector = await generateEmbedding(query);

  const must = [];
  if (customerId) {
    must.push({ key: "customerId", match: { value: customerId } });
  }
  if (category) {
    must.push({ key: "category", match: { value: category } });
  }

  const response = await qdrant.query(COLLECTION_NAME, {
    query: queryVector,
    limit: topK,
    score_threshold: minScore,
    with_payload: true,
    ...(must.length > 0 && { filter: { must } }),
  });

  const hits = response?.points || [];

  // Cross-check documentIds against MySQL so deleted/unindexed docs never leak
  const docIds = [...new Set(hits.map((h) => h.payload?.documentId).filter(Boolean))];
  const validDocs = docIds.length
    ? await prisma.customerDocument.findMany({
        where: { id: { in: docIds }, ragStatus: "INDEXED" },
        select: { id: true, title: true, fileName: true, category: true, customerId: true },
      })
    : [];

  const validDocMap = new Map(validDocs.map((d) => [d.id, d]));

  return hits
    .filter((h) => h.payload?.documentId && validDocMap.has(h.payload.documentId))
    .map((h) => {
      const dbDoc = validDocMap.get(h.payload.documentId);
      return {
        id: h.id,
        score: h.score,
        chunkIndex: h.payload.chunkIndex,
        content: h.payload.content,
        customerId: h.payload.customerId || dbDoc.customerId,
        document: {
          id: dbDoc.id,
          title: dbDoc.title || dbDoc.fileName,
          fileName: dbDoc.fileName,
          category: dbDoc.category,
        },
      };
    });
}

export async function askKnowledgeBase({ query, customerId, category }) {
  const matches = await retrieveRelevantChunks({
    query,
    customerId,
    category,
    topK: 5,
  });

  if (matches.length === 0) {
    return {
      answer: "I could not find relevant information in the indexed documents.",
      confidence: "low",
      sources: [],
      matchedCustomers: [],
    };
  }

  // Optional: fetch related Customer records when searching globally across customers
  const matchedCustomerIds = [
    ...new Set(matches.map((m) => m.customerId).filter(Boolean)),
  ];
  const matchedCustomers = matchedCustomerIds.length
    ? await prisma.customer.findMany({
        where: { id: { in: matchedCustomerIds } },
        select: { id: true, customerName: true, ContactNumber: true, City: true },
      })
    : [];

  const contextBlock = matches
    .map(
      (m, idx) =>
        `[Source ${idx + 1}: ${m.document.title} (${m.document.category})]\n${m.content}`
    )
    .join("\n\n---\n\n");

  const promptText = `You are a CRM Knowledge Base assistant. Answer the user's question using ONLY the provided document excerpts. If the answer is not present in the excerpts, say so clearly.

Respond with a single valid JSON object matching this exact structure:
{
  "answer": "clear and concise answer based strictly on the context",
  "confidence": "high" | "medium" | "low"
}

DOCUMENT EXCERPTS:
${contextBlock}

USER QUESTION:
${query}`;

  const { client, model, provider } = await getDynamicAIContext(
    "GEMINI",
    "models/gemini-2.5-flash-lite"
  );

  const raw = await executeDynamicPrompt(client, model, provider, promptText);
  const parsed = safeJsonParse(raw);

  return {
    answer: parsed?.answer || "Unable to generate a response.",
    confidence: parsed?.confidence || "low",
    sources: matches.map((m) => ({
      documentId: m.document.id,
      title: m.document.title,
      category: m.document.category,
      customerId: m.customerId,
      score: Number(m.score.toFixed(3)),
    })),
    matchedCustomers,
  };
}