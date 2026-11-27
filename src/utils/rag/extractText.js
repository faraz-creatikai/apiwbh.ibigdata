// utils/rag/extractText.js
import { createRequire } from "module";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

// createRequire avoids pdf-parse's known ESM import quirk
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

export async function extractTextFromBuffer(buffer, mimeType = "", fileName = "") {
  const mime = mimeType.toLowerCase();
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  // 1. PDF
  if (mime === "application/pdf" || ext === "pdf") {
    const parsed = await pdfParse(buffer);
    return parsed.text || "";
  }

  // 2. Word (.docx)
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  // 3. Excel (.xlsx, .xls)
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

  // 4. Plain Text / CSV / JSON / Markdown
  if (mime.startsWith("text/") || ["txt", "csv", "md", "json"].includes(ext)) {
    return buffer.toString("utf-8");
  }

  throw new Error(`Unsupported file type for RAG text extraction: ${mimeType || ext}`);
}