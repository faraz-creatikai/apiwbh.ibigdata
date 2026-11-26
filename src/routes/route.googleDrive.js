// routes/route.googleDrive.js
import express from "express";
import {
  getGDriveAuthUrl,
  handleGDriveCallback,
  getGDriveStatus,
  disconnectGDrive,
} from "../controllers/controller.googleDrive.js";
import { protectRoute } from "../middlewares/auth.js";

const gDriveRoutes = express.Router();

// Public OAuth callback (Google redirects here)
gDriveRoutes.get("/callback", handleGDriveCallback);

// Protected routes for logged-in admins
gDriveRoutes.use(protectRoute);

gDriveRoutes.get("/auth-url", getGDriveAuthUrl);
gDriveRoutes.get("/status", getGDriveStatus);
gDriveRoutes.delete("/disconnect", disconnectGDrive);

export default gDriveRoutes;