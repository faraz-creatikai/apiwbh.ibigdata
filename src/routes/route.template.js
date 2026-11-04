import express from "express";
import {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
} from "../controllers/controller.template.js";
import { protectRoute } from "../middlewares/auth.js";
import upload, { templateUpload } from "../config/multer.js";

const templateRoute = express.Router();

templateRoute.use(protectRoute);

templateRoute.post(
  "/",
  templateUpload.fields([{ name: "whatsappImage", maxCount: 5 }]), // 👈 changed from upload
  createTemplate
);
templateRoute.get("/", getTemplates);
templateRoute.get("/:id", getTemplateById);
templateRoute.put(
  "/:id",
  templateUpload.fields([{ name: "whatsappImage", maxCount: 5 }]), // 👈 changed from upload
  updateTemplate
);
templateRoute.delete("/:id", deleteTemplate);

export default templateRoute;
