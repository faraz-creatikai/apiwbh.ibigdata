// utils/rag/chunker.js

/**
 * Splits text into overlapping chunks optimized for MiniLM embeddings.
 * @param {string} rawText
 * @param {number} chunkSize   Target max characters per chunk (~200 tokens)
 * @param {number} overlap     Overlap characters between adjacent chunks
 */
export function chunkText(rawText, chunkSize = 800, overlap = 150) {
  const clean = String(rawText || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);

    // Try to break cleanly on a paragraph, newline, or sentence end
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const breakIdx = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("\n")
      );
      if (breakIdx > chunkSize * 0.4) {
        end = start + breakIdx + 1;
      }
    }

    const piece = clean.slice(start, end).trim();
    if (piece.length > 20) chunks.push(piece);

    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}