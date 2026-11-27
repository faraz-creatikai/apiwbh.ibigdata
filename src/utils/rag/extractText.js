import { createRequire } from "module";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

const require = createRequire(import.meta.url);
const pdfModule = require("pdf-parse");

async function parsePdfBuffer(buffer) {
  // pdf-parse v2+ (class-based API)
  if (typeof pdfModule?.PDFParse === "function") {
    const parser = new pdfModule.PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result?.text || "";
    } finally {
      await parser.destroy?.();
    }
  }

  // pdf-parse v1 fallback (function-based API)
  const fn = typeof pdfModule === "function" ? pdfModule : pdfModule?.default;
  if (typeof fn === "function") {
    const parsed = await fn(buffer);
    return parsed?.text || "";
  }

  throw new Error("Unsupported pdf-parse module export");
}

export async function extractTextFromBuffer(buffer, mimeType = "", fileName = "") {
  const mime = String(mimeType || "").toLowerCase();
  const ext = String(fileName || "").split(".").pop()?.toLowerCase() || "";

  if (mime === "application/pdf" || ext === "pdf") {
    return await parsePdfBuffer(buffer);
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