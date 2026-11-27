import { createRequire } from "module";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { createWorker } from "tesseract.js";
import { pdf } from "pdf-to-img";

const require = createRequire(import.meta.url);
const pdfModule = require("pdf-parse");

async function ocrImageBuffers(buffers) {
  if (!buffers.length) return "";
  const worker = await createWorker("eng");
  try {
    const pagesText = [];
    for (const imgBuf of buffers) {
      const { data } = await worker.recognize(imgBuf);
      if (data?.text?.trim()) {
        pagesText.push(data.text.trim());
      }
    }
    return pagesText.join("\n\n");
  } finally {
    await worker.terminate();
  }
}

async function parsePdfBuffer(buffer) {
  let extracted = "";

  // 1. Try fast native text extraction first
  if (typeof pdfModule?.PDFParse === "function") {
    const parser = new pdfModule.PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      extracted = result?.text || "";
    } finally {
      await parser.destroy?.();
    }
  } else {
    const fn = typeof pdfModule === "function" ? pdfModule : pdfModule?.default;
    if (typeof fn === "function") {
      const parsed = await fn(buffer);
      extracted = parsed?.text || "";
    }
  }

  // Strip page markers like "-- 1 of 6 --" to check if real text exists
  const meaningfulText = extracted.replace(/--\s*\d+\s*of\s*\d+\s*--/gi, "").trim();
  if (meaningfulText.length >= 40) {
    return extracted;
  }

  // 2. Scanned PDF detected -> render pages to images and run local OCR (up to 15 pages)
  const pageImages = [];
  const document = await pdf(buffer, { scale: 2 });
  for await (const imageBuffer of document) {
    pageImages.push(imageBuffer);
    if (pageImages.length >= 15) break;
  }

  return await ocrImageBuffers(pageImages);
}

export async function extractTextFromBuffer(buffer, mimeType = "", fileName = "") {
  const mime = String(mimeType || "").toLowerCase();
  const ext = String(fileName || "").split(".").pop()?.toLowerCase() || "";

  if (mime === "application/pdf" || ext === "pdf") {
    return await parsePdfBuffer(buffer);
  }

  if (
    mime.startsWith("image/") ||
    ["png", "jpg", "jpeg", "webp"].includes(ext)
  ) {
    return await ocrImageBuffers([buffer]);
  }

  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    ext === "xlsx" ||
    ext === "xls"
  ) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return workbook.SheetNames.map((sheetName) => {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      return `Sheet: ${sheetName}\n${csv}`;
    }).join("\n\n");
  }

  if (mime.startsWith("text/") || ["txt", "csv", "md", "json"].includes(ext)) {
    return buffer.toString("utf-8");
  }

  throw new Error(`Unsupported file type for RAG text extraction: ${mimeType || ext}`);
}