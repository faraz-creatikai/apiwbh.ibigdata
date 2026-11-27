import { createRequire } from "module";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { createWorker } from "tesseract.js";
import { renderPageAsImage, getDocumentProxy } from "unpdf";

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
  let parsedSuccessfully = false;

  // 1. Try fast native text extraction first (pdf-parse v2 & v1)
  if (typeof pdfModule?.PDFParse === "function") {
    const parser = new pdfModule.PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      extracted = result?.text || "";
      parsedSuccessfully = true;
    } finally {
      await parser.destroy?.();
    }
  } else {
    const fn = typeof pdfModule === "function" ? pdfModule : pdfModule?.default;
    if (typeof fn === "function") {
      const parsed = await fn(buffer);
      extracted = parsed?.text || "";
      parsedSuccessfully = true;
    }
  }

  if (!parsedSuccessfully) {
    throw new Error("Unsupported pdf-parse module export");
  }

  const meaningfulText = extracted.replace(/--\s*\d+\s*of\s*\d+\s*--/gi, "").trim();
  if (meaningfulText.length >= 40) {
    return extracted;
  }

  // 2. Scanned PDF fallback -> render pages purely in Node via unpdf + @napi-rs/canvas
  const pdfDoc = await getDocumentProxy(new Uint8Array(buffer));
  const totalPages = Math.min(pdfDoc.numPages || 1, 15);
  const pageImages = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const arrayBuf = await renderPageAsImage(pdfDoc, pageNum, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale: 2,
    });
    pageImages.push(Buffer.from(arrayBuf));
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