import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";

// Helper: Convert Prisma output to MongoDB-style
const transformAgent = (agent) => ({
    _id: agent.id,
    name: agent.name,
    description: agent.description,
    type: agent.type,
    status: agent.status,
    campaign: agent.campaign,
    targetSegment: agent.targetSegment,
    capability: agent.capability,
    AssignTo: agent.AssignTo,
    createdAt: agent.createdAt,
});

// GET ALL AI AGENTS
export const getAIAgents = async (req, res, next) => {
    try {
        const { keyword, limit, type, campaign } = req.query;

        let where = {};

        if (keyword) {
            where.name = { contains: keyword, mode: "insensitive" };
        }

        if (type) {
            where.type = type;
        }

        if (campaign) {
            where.campaign = campaign;
        }

        const agents = await prisma.aIAgent.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: limit ? Number(limit) : undefined,
            include: {
                AssignTo: {
                    select: { id: true, name: true, email: true, role : true },
                },
            },
        });

        res.status(200).json(agents.map(transformAgent));
    } catch (error) {
        next(new ApiError(500, error.message));
    }
};

// GET AI AGENT BY ID
export const getAIAgentById = async (req, res, next) => {
    try {
        const agent = await prisma.aIAgent.findUnique({
            where: { id: req.params.id },
        });

        if (!agent) return next(new ApiError(404, "AI Agent not found"));

        res.status(200).json(transformAgent(agent));
    } catch (error) {
        next(new ApiError(500, error.message));
    }
};

// CREATE AI AGENT
export const createAIAgent = async (req, res, next) => {
    try {
        const {
            name,
            description,
            type,
            status,
            campaign,
            targetSegment,
            capability,
        } = req.body;

        const newAgent = await prisma.aIAgent.create({
            data: {
                name,
                description,
                type,
                status,
                campaign,
                targetSegment,
                capability,
            },
        });

        res.status(201).json(transformAgent(newAgent));
    } catch (error) {
        next(new ApiError(400, error.message));
    }
};

// UPDATE AI AGENT
export const updateAIAgent = async (req, res, next) => {
    try {
        const { id } = req.params;

        let updateData = { ...req.body };

        // Remove non-updatable fields
        delete updateData.id;
        delete updateData._id;
        delete updateData.createdAt;

        const updatedAgent = await prisma.aIAgent.update({
            where: { id },
            data: updateData,
        });

        res.status(200).json(transformAgent(updatedAgent));
    } catch (error) {
        if (error.code === "P2025") {
            return next(new ApiError(404, "AI Agent not found"));
        }
        next(new ApiError(400, error.message));
    }
};

//Assign AI Agent to users

export const assignAIAgent = async (req, res, next) => {
    try {
        const { agentId, userIds } = req.body;

        if (!agentId) {
            return next(new ApiError(400, "Agent ID is required"));
        }

        if (!Array.isArray(userIds)) {
            return next(new ApiError(400, "userIds must be an array"));
        }

        // 1. Check if agent exists
        const agent = await prisma.aIAgent.findUnique({
            where: { id: agentId },
        });

        if (!agent) {
            return next(new ApiError(404, "AI Agent not found"));
        }

        // ❗ Business rule: don't allow assignment if inactive
        if (agent.status !== "Active") {
            return next(new ApiError(400, "Cannot assign users to inactive agent"));
        }

        // 2. Update assignments (replace all)
        const updatedAgent = await prisma.aIAgent.update({
            where: { id: agentId },
            data: {
                AssignTo: {
                    set: userIds.map((id) => ({ id })),
                },
            },
            include: {
                AssignTo: {
                    select: { id: true, name: true, email: true },
                },
            },
        });

        res.status(200).json({
            success: true,
            message: "Agent assigned successfully",
            data: updatedAgent,
        });
    } catch (error) {
        next(new ApiError(500, error.message));
    }
};


// DELETE AI AGENT
export const deleteAIAgent = async (req, res, next) => {
    try {
        await prisma.aIAgent.delete({
            where: { id: req.params.id },
        });

        res.status(200).json({ message: "AI Agent deleted successfully" });
    } catch (error) {
        if (error.code === "P2025") {
            return next(new ApiError(404, "AI Agent not found"));
        }
        next(new ApiError(500, error.message));
    }
};