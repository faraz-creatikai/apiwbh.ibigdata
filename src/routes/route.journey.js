import express from "express";
import { protectRoute } from "../middlewares/auth.js";

import {
  listJourneys,
  createJourney,
  getJourney,
  updateJourney,
  updateJourneyStatus,
  deleteJourney,
  getAnalytics,
  createTestExecution,
  runTestExecution,
  listExecutions,
  enrollCustomers,
  listEnrollments,
  getEnrollment,
  cancelEnrollment,
  runJourneyForEnrolled,
} from "../controllers/controller.journey.js";
import { runJourneyWorker } from "../jobs/journey/journeyWorker.js";

const journeyRoute = express.Router();

// Cron worker: secured by CRON_SECRET, so it sits BEFORE protectRoute.
journeyRoute.post("/worker/run", runJourneyWorker);

// Everything below requires a logged-in admin (JWT or x-api-key).
journeyRoute.use(protectRoute);

// Keep static paths above "/:id" routes.
journeyRoute.get("/analytics", getAnalytics);

// Journeys
journeyRoute.get("/", listJourneys);
journeyRoute.post("/", createJourney);
journeyRoute.get("/:id", getJourney);
journeyRoute.put("/:id", updateJourney);
journeyRoute.patch("/:id/status", updateJourneyStatus);
journeyRoute.delete("/:id", deleteJourney);

// Test executions
journeyRoute.post("/:id/test", createTestExecution);
journeyRoute.post("/:id/test/:executionId/run", runTestExecution);
journeyRoute.get("/:id/executions", listExecutions);

// Enrollments
journeyRoute.post("/:id/enroll", enrollCustomers);
journeyRoute.get("/:id/enrollments", listEnrollments);
journeyRoute.get("/:id/enrollments/:enrollmentId", getEnrollment);
journeyRoute.patch("/:id/enrollments/:enrollmentId", cancelEnrollment);
journeyRoute.post("/:id/run", runJourneyForEnrolled);

export default journeyRoute;