import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";

const transformCampaign = (campaign) => ({
  _id: campaign.id,
  Name: campaign.Name,
  Status: campaign.Status,
  createdAt: campaign.createdAt,
  updatedAt: campaign.updatedAt,
});

// GET ALL CAMPAIGNS
export const getCampaign = async (req, res, next) => {
  try {
    const { keyword, limit } = req.query;

    let where = {};
    if (keyword) {
      where.Name = { contains: keyword, mode: "insensitive" };
    }

    const campaigns = await prisma.campaign.findMany({
      where,
      orderBy: { Name: "asc" },
      take: limit ? Number(limit) : undefined,
    });

    res.status(200).json(campaigns.map(transformCampaign));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// GET CAMPAIGN BY ID
export const getCampaignById = async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
    });

    if (!campaign) return next(new ApiError(404, "Campaign not found"));

    res.status(200).json(transformCampaign(campaign));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// CREATE CAMPAIGN
export const createCampaign = async (req, res, next) => {
  try {
    const { Name, Status } = req.body;

    const newCampaign = await prisma.campaign.create({
      data: { Name, Status },
    });

    res.status(201).json(transformCampaign(newCampaign));
  } catch (error) {
    next(new ApiError(400, error.message));
  }
};

// UPDATE CAMPAIGN
export const updateCampaign = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Clone body safely
    let updateData = { ...req.body };

    // 🚫 Remove fields that Prisma should NOT update
    delete updateData.id;
    delete updateData._id;
    delete updateData.createdAt;
    delete updateData.updatedAt;
    delete updateData.CreatedBy;

    // 🚫 If your campaign has relations like types or subTypes,
    // and you are not updating them in this request:
    // ensure they are not accidentally included
    delete updateData.types;
    delete updateData.subTypes;

    const updatedCampaign = await prisma.campaign.update({
      where: { id },
      data: updateData,
    });

    res.status(200).json(transformCampaign(updatedCampaign));
  } catch (error) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "Campaign not found"));
    }
    next(new ApiError(400, error.message));
  }
};

export const deleteCampaign = async (req, res, next) => {
  try {
    const id = req.params.id;

    // 1️⃣ DELETE SubTypes first (depends on Campaign + Type)
    await prisma.subType.deleteMany({
      where: { campaignId: id },
    });

    // 2️⃣ DELETE Types (depends on Campaign)
    await prisma.type.deleteMany({
      where: { campaignId: id },
    });

    // 3️⃣ DELETE Campaign
    await prisma.campaign.delete({
      where: { id },
    });

    res.status(200).json({ message: "Campaign deleted successfully" });
  } catch (error) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "Campaign not found"));
    }
    next(new ApiError(500, error.message));
  }
};
