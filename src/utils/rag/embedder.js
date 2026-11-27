// utils/rag/embedder.js
import { pipeline } from "@huggingface/transformers";

let embedderPromise = null;

async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "q8", // Quantized 8-bit: fast on CPU, tiny RAM footprint
    });
  }
  return embedderPromise;
}

/**
 * Generates a normalized 384-dimension embedding vector for a text string.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text) {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/**
 * Dot product of two normalized vectors === Cosine Similarity (-1 to 1).
 */
export function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
  }
  return dot;
}