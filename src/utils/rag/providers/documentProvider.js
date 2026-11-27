import prisma from "../../../config/prismaClient.js";
import { qdrant, COLLECTION_NAME, ensureQdrantCollection } from "../qdrantClient.js";
import { generateEmbedding } from "../embedder.js";

const seesAll = (a) => a?.isSuperAdmin || a?.role === "administrator";

export async function fetchDocumentContext({
  admin,
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
    limit: topK * 2, // fetch extra before admin-access filtering
    score_threshold: minScore,
    with_payload: true,
    ...(must.length > 0 && { filter: { must } }),
  });

  const hits = response?.points || [];
  if (hits.length === 0) return [];

  const docIds = [...new Set(hits.map((h) => h.payload?.documentId).filter(Boolean))];
  if (docIds.length === 0) return [];

  // Enforce MySQL status + admin access control
  const validDocs = await prisma.customerDocument.findMany({
    where: {
      id: { in: docIds },
      ragStatus: "INDEXED",
      ...(admin && !seesAll(admin) && { uploadedById: admin.id }),
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

  const validDocMap = new Map(validDocs.map((d) => [d.id, d]));

  return hits
    .filter((h) => h.payload?.documentId && validDocMap.has(h.payload.documentId))
    .slice(0, topK)
    .map((h) => {
      const dbDoc = validDocMap.get(h.payload.documentId);
      return {
        id: h.id,
        score: h.score,
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