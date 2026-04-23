import express from "express";


import { validate } from "../middlewares/validate.js";


import { isAdministrator, protectRoute } from "../middlewares/auth.js";
import { createAIAgentValidator, updateAIAgentValidator } from "../validators/aiagentValidator.js";
import { assignAIAgent, createAIAgent, deleteAIAgent, getAIAgentById, getAIAgents, updateAIAgent } from "../controllers/controller.aiagent.js";

const aiAgentRoutes = express.Router();

// Protect all routes
aiAgentRoutes.use(protectRoute);

// GET ALL AGENTS
aiAgentRoutes.get("/", getAIAgents);

// GET SINGLE AGENT
aiAgentRoutes.get("/:id", isAdministrator, getAIAgentById);

// CREATE AGENT
aiAgentRoutes.post(
    "/",
    isAdministrator,
    validate(createAIAgentValidator),
    createAIAgent
);

// UPDATE AGENT
aiAgentRoutes.put(
    "/:id",
    isAdministrator,
    validate(updateAIAgentValidator),
    updateAIAgent
);

//ASSIGN AGENT
aiAgentRoutes.post("/assign", assignAIAgent);

// DELETE AGENT
aiAgentRoutes.delete("/:id", isAdministrator, deleteAIAgent);

export default aiAgentRoutes;