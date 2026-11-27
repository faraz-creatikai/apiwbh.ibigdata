import { QdrantClient } from "@qdrant/js-client-rest";
import { clientName } from "../../config/cors-origins.js";

export const COLLECTION_NAME = `${clientName}_knowledge_base`;

export const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

export async function ensureQdrantCollection() {
  const { exists } = await qdrant.collectionExists(COLLECTION_NAME);

  if (!exists) {
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: { size: 384, distance: "Cosine" },
    });
  }

  const collectionInfo = await qdrant.getCollection(COLLECTION_NAME);
  const schema = collectionInfo?.payload_schema || {};

  const indexesToCreate = [];
  if (!schema.documentId) {
    indexesToCreate.push(
      qdrant.createPayloadIndex(COLLECTION_NAME, {
        field_name: "documentId",
        field_schema: "keyword",
        wait: true,
      })
    );
  }
  if (!schema.customerId) {
    indexesToCreate.push(
      qdrant.createPayloadIndex(COLLECTION_NAME, {
        field_name: "customerId",
        field_schema: "keyword",
        wait: true,
      })
    );
  }
  if (!schema.category) {
    indexesToCreate.push(
      qdrant.createPayloadIndex(COLLECTION_NAME, {
        field_name: "category",
        field_schema: "keyword",
        wait: true,
      })
    );
  }

  if (indexesToCreate.length > 0) {
    await Promise.all(indexesToCreate);
  }
}

export async function deleteDocumentVectors(documentId) {
  if (!documentId) return;
  await qdrant.delete(COLLECTION_NAME, {
    filter: {
      must: [{ key: "documentId", match: { value: documentId } }],
    },
    wait: true,
  });
}