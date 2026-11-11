// routes/route.outreachCampaign.js
// Mount it where your other routes are mounted, e.g.:  app.use("/v1/campaigns", campaignRoute);
import express from "express";
import { protectRoute } from "../middlewares/auth.js";
import {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
} from "../controllers/controller.outreachCampaign.js";
import { cancelCampaignRun, getCampaignRun, getCampaignRuns, runCampaignNow } from "../controllers/controller.outreachCampaignRun.js";
import { createSchedule, deleteSchedule, listSchedules, updateSchedule } from "../controllers/controller.outreachCampaignSchedule.js";

const outreachCampaignRoute = express.Router();

outreachCampaignRoute.use(protectRoute);

outreachCampaignRoute.post("/", createCampaign);
outreachCampaignRoute.get("/", getCampaigns);
outreachCampaignRoute.get("/:id", getCampaignById);
outreachCampaignRoute.put("/:id", updateCampaign);
outreachCampaignRoute.delete("/:id", deleteCampaign);


// run routes

// running + reports
outreachCampaignRoute.post("/:id/run", runCampaignNow);
outreachCampaignRoute.get("/:id/runs", getCampaignRuns);
outreachCampaignRoute.get("/:id/runs/:runId", getCampaignRun);
outreachCampaignRoute.post("/:id/runs/:runId/cancel", cancelCampaignRun);


//scheduler

outreachCampaignRoute.get("/:id/schedules", listSchedules);
outreachCampaignRoute.post("/:id/schedules", createSchedule);
outreachCampaignRoute.put("/:id/schedules/:scheduleId", updateSchedule);
outreachCampaignRoute.delete("/:id/schedules/:scheduleId", deleteSchedule);

export default outreachCampaignRoute;