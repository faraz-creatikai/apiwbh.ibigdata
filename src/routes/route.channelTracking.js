import express from "express";
import { protectRoute } from "../middlewares/auth.js";
import { trackOpen, channelStats } from "../utils/channelTracking.js";

const channelTrackingRoutes = express.Router();
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

// 👇 Add this temporary logger to catch EVERYTHING sent to /api/channel-tracking
channelTrackingRoutes.use((req, res, next) => {
  console.log(`[TRACKING ROUTER HIT] Method: ${req.method}, Path: ${req.path}`);
  next();
});

// PUBLIC (no login): the 1x1 image inside sent emails
channelTrackingRoutes.get("/o/:file", async (req, res) => {
  await trackOpen(req.params.file.replace(/\.gif$/i, "")).catch(() => {});
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" }).end(GIF);
});


// PROTECTED: GET /track/stats?channel=email&days=30
channelTrackingRoutes.get("/stats", protectRoute, async (req, res, next) => {
  try {
    const channel = req.query.channel === "whatsapp_baileys" ? "whatsapp_baileys" : "email";
    res.json({ success: true, data: await channelStats(req.admin, channel, Number(req.query.days) || 30) });
  } catch (e) { next(e); }
});

export default channelTrackingRoutes;