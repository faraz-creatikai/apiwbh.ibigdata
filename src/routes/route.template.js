import express from "express";
import {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
} from "../controllers/controller.template.js";
import { isAdministrator, protectRoute } from "../middlewares/auth.js";
import upload from "../config/multer.js";

const templateRoute = express.Router();

templateRoute.use(protectRoute);

templateRoute.post("/", upload.fields([
    { name: "whatsappImage", maxCount: 5 },
  ]), createTemplate);
templateRoute.get("/", isAdministrator, getTemplates);
templateRoute.get("/:id", isAdministrator, getTemplateById);
templateRoute.put("/:id",upload.fields([
    { name: "whatsappImage", maxCount: 5 },
  ]), isAdministrator, updateTemplate);
templateRoute.delete("/:id", isAdministrator, deleteTemplate);

export default templateRoute;
