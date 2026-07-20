import multer from "multer";
import path from "path";
import fs from "fs";

const uploadDir = "uploads/";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpg|jpeg|png|webp/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.test(ext)) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

// 👇 NEW: separate instance for Template uploads (whatsapp image/video/document
// + mail image). Reuses the same disk storage/filename logic above, so nothing
// about where files land or how they're named changes — only which extensions
// are accepted, and only on the routes that opt into this instance.
const templateUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // raised for video/document templates
  fileFilter: (req, file, cb) => {
    const allowed = /jpg|jpeg|png|webp|gif|mp4|mov|webm|pdf|doc|docx|xls|xlsx/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.test(ext)) cb(null, true);
    else
      cb(
        new Error(
          "Unsupported file type. Allowed: images (jpg/jpeg/png/webp/gif), video (mp4/mov/webm), or documents (pdf/doc/docx/xls/xlsx)."
        )
      );
  },
});

export default upload;
export { templateUpload };