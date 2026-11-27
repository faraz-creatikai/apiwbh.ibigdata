import prisma from "../../../config/prismaClient.js";
import { qdrant, COLLECTION_NAME, ensureQdrantCollection } from "../qdrantClient.js";
import { generateEmbedding } from "../embedder.js";

const seesAll = (a) => a?.isSuperAdmin || a?.role === "administrator";

export async function fetchDocumentContext({
  admin,
  query,
  customerId,
  customerIds = [],
  category,
  topK = 5,
  minScore = 0.2,
}) {
  await ensureQdrantCollection();

  const targetCustomerIds = customerId
    ? [customerId]
    : customerIds.filter(Boolean);

  // 1. Find valid INDEXED documents in MySQL that this admin is allowed to see
  const allowedDocs = await prisma.customerDocument.findMany({
    where: {
      ragStatus: "INDEXED",
      ...(admin && !seesAll(admin) && { uploadedById: admin.id }),
      ...(targetCustomerIds.length > 0 && {
        customerId: { in: targetCustomerIds },
      }),
      ...(category && { category }),
    },
    select: {
      id: true,
      title: true,
      fileName: true,
      category: true,
      customerId: true,
      customer: { select: { id: true, customerName: true, ContactNumber: true } },
    },
  });

  if (allowedDocs.length === 0) return [];

  const validDocMap = new Map(allowedDocs.map((d) => [d.id, d]));
  const allowedDocIds = allowedDocs.map((d) => d.id);

  // 2. Semantic vector search filtered strictly to allowed documentIds
  const queryVector = await generateEmbedding(query);

  const response = await qdrant.query(COLLECTION_NAME, {
    query: queryVector,
    limit: topK,
    score_threshold: minScore,
    with_payload: true,
    filter: {
      must: [{ key: "documentId", match: { any: allowedDocIds } }],
    },
  });

  let hits = response?.points || [];

  // 3. Fallback: if specific customer(s) were targeted (e.g. "what is Faraz's document about?")
  // and semantic score was below threshold, pull the opening chunks of their documents
  if (hits.length === 0 && targetCustomerIds.length > 0) {
    const scrollRes = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: [{ key: "documentId", match: { any: allowedDocIds } }],
      },
      limit: topK,
      with_payload: true,
    });
    hits = (scrollRes?.points || []).map((p) => ({ ...p, score: 0.5 }));
  }

  return hits
    .filter((h) => h.payload?.documentId && validDocMap.has(h.payload.documentId))
    .slice(0, topK)
    .map((h) => {
      const dbDoc = validDocMap.get(h.payload.documentId);
      return {
        id: h.id,
        score: h.score ?? 0.5,
        chunkIndex: h.payload.chunkIndex,
        content: h.payload.content,
        customerId: h.payload.customerId || dbDoc.customerId,
        customerName: dbDoc.customer?.customerName || null,
        document: {
          id: dbDoc.id,
          title: dbDoc.title || dbDoc.fileName,
          fileName: dbDoc.fileName,
          category: dbDoc.category,
        },
      };
    });
}