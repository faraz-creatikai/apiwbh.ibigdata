// routes/route.googleDrive.js
import express from "express";

import { protectRoute } from "../middlewares/auth.js";
import upload, { gdriveUpload } from "../config/multer.js";
import { askCrmAssistant, reindexCustomerDocument } from "../controllers/controller.rag.js";

const ragRoutes = express.Router();

// Public OAuth callback (Google redirects here)


// Protected routes for logged-in admins
ragRoutes.use(protectRoute);


ragRoutes.post("/documents/:id/reindex", reindexCustomerDocument);
ragRoutes.post("/ai/ask", askCrmAssistant);

export default ragRoutes;