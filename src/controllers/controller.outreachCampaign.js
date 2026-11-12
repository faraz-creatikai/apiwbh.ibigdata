// controllers/controller.outreachCampaign.js
//
// Create / list / get / edit / delete outreach campaigns.
// (Manual run, scheduling and reports come later; their tables already exist in the schema.)
//
//  - An admin sees only the campaigns they created. Super admins and role "administrator" see all.
//  - Customers are checked against the saving admin's own access (same rule as every other controller),
//    so nobody can put a customer they aren't allowed to see into a campaign.
//  - Edit and delete are refused while a run is in progress.

import { z } from "zod";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { getCustomerAccessFilter } from "./controller.customer.js";
import { trackingForRuns } from "./controller.outreachCampaignRun.js";

const CHANNELS = ["email", "whatsapp_baileys", "whatsapp_meta", "ai_calling"];
// Most customers one campaign may target. Static for now; later this can come from your tool limit.
const MAX_CAMPAIGN_CUSTOMERS = 500;

const bodySchema = z.object({
    name: z.string().trim().min(1, "Campaign name is required").max(120),
    description: z.string().trim().max(500).nullish(),
    channels: z.array(z.enum(CHANNELS)).min(1, "Choose at least one channel"),
    emailTemplateId: z.string().uuid().nullish(),
    whatsappTemplateId: z.string().uuid().nullish(),
    aiAgentId: z.string().trim().max(100).nullish(),
    customerIds: z
        .array(z.string())
        .min(1, "Select at least one customer")
        .max(MAX_CAMPAIGN_CUSTOMERS, `A campaign can have at most ${MAX_CAMPAIGN_CUSTOMERS} customers`),
    status: z.enum(["active", "paused"]).optional(),
});

/* ------------------------------ helpers ------------------------------ */

const fail = (err, next) => next(err instanceof ApiError ? err : new ApiError(500, err.message));

const seesAll = (a) => a.isSuperAdmin || a.role === "administrator";
export const ownedWhere = (admin) => (seesAll(admin) ? {} : { createdById: admin.id });
const findOwned = (admin, id) => prisma.outreachCampaign.findFirst({ where: { id, ...ownedWhere(admin) } });

// list rows never carry the customer id list (it can be thousands of ids)
const LIST_SELECT = {
    id: true,
    name: true,
    description: true,
    status: true,
    channels: true,
    emailTemplateId: true,
    whatsappTemplateId: true,
    aiAgentId: true,
    customerCount: true,
    lastRunAt: true,
    createdAt: true,
    updatedAt: true,
    emailTemplate: { select: { id: true, name: true } },
    whatsappTemplate: { select: { id: true, name: true } },
    createdBy: { select: { id: true, name: true } },
    _count: { select: { schedules: true, runs: true } },
};

const assertNotRunning = async (campaignId) => {
    const running = await prisma.outreachCampaignRun.findFirst({ where: { campaignId, status: "running" }, select: { id: true } });
    if (running) throw new ApiError(409, "This campaign is running right now. Try again when it finishes.");
};

/** Validates the body and returns the clean data to save. Used by both create and edit. */
const parseCampaign = async (admin, body) => {
    const parsed = bodySchema.safeParse(body || {});
    if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => i.message).join(", "));
    const d = parsed.data;

    const channels = [...new Set(d.channels)];
    const wantsEmail = channels.includes("email");
    const wantsWhatsapp = channels.some((c) => c.startsWith("whatsapp_"));

    if (wantsEmail && !d.emailTemplateId) throw new ApiError(400, "Choose an email template");
    if (wantsWhatsapp && !d.whatsappTemplateId) throw new ApiError(400, "Choose a WhatsApp template");

    // each chosen template must exist, be the right kind, and be active
    for (const [id, type] of [[wantsEmail && d.emailTemplateId, "email"], [wantsWhatsapp && d.whatsappTemplateId, "whatsapp"]]) {
        if (!id) continue;
        const t = await prisma.template.findUnique({ where: { id }, select: { type: true, status: true } });
        if (!t || t.type !== type) throw new ApiError(400, `The selected ${type} template was not found`);
        if (t.status === "Inactive") throw new ApiError(400, `The selected ${type} template is inactive`);
    }

    // only customers this admin is allowed to see
    const access = await getCustomerAccessFilter(admin);
    const ids = [...new Set(d.customerIds)];
    const allowed = await prisma.customer.findMany({
        where: { AND: [access, { id: { in: ids } }] },
        select: { id: true },
    });
    if (!allowed.length) throw new ApiError(400, "None of the selected customers are available to you");

    return {
        removed: ids.length - allowed.length, // ids that were unknown or not allowed
        data: {
            name: d.name,
            description: d.description || "",
            channels,
            emailTemplateId: wantsEmail ? d.emailTemplateId : null,
            whatsappTemplateId: wantsWhatsapp ? d.whatsappTemplateId : null,
            aiAgentId: channels.includes("ai_calling") ? d.aiAgentId || null : null,
            customerIds: allowed.map((c) => c.id),
            customerCount: allowed.length,
            ...(d.status && { status: d.status }),
        },
    };
};

/* ------------------------------ handlers ------------------------------ */

// POST /campaigns
export const createCampaign = async (req, res, next) => {
    try {
        const { data, removed } = await parseCampaign(req.admin, req.body);
        const campaign = await prisma.outreachCampaign.create({
            data: { ...data, createdById: req.admin.id },
            select: LIST_SELECT,
        });
        res.status(201).json({ success: true, removedCustomers: removed, data: campaign });
    } catch (err) {
        fail(err, next);
    }
};

// GET /campaigns?page=&limit=&search=
// GET /campaigns?page=&limit=&search=
export const getCampaigns = async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
        const search = String(req.query.search || "").trim();
        const channels = String(req.query.channel || "").split(",").filter(Boolean);
        const where = {
            ...ownedWhere(req.admin),
            ...(search && { name: { contains: search } }),
            ...(channels.length && { OR: channels.map((c) => ({ channels: { path: "$", array_contains: c } })) }),
        };

        const [total, data] = await Promise.all([
            prisma.outreachCampaign.count({ where }),
            prisma.outreachCampaign.findMany({
                where,
                select: LIST_SELECT,
                orderBy: { createdAt: "desc" },
                skip: (page - 1) * limit,
                take: limit,
            }),
        ]);

        if (data.length === 0) {
            return res.json({ success: true, total, currentPage: page, totalPages: 0, data });
        }

        // Fetch all runs for the campaigns on this page to calculate lifetime tracking stats
        const campaignIds = data.map((c) => c.id);
        const runs = await prisma.outreachCampaignRun.findMany({
            where: { campaignId: { in: campaignIds } },
            select: { id: true, campaignId: true, summary: true }
        });

        // Use your existing trackingForRuns helper to get the detailed metrics for these runs
        const tmap = await trackingForRuns(runs);

        // Map the stats back to the parent campaigns
        const enrichedData = data.map((campaign) => {
            const campaignRuns = runs.filter(r => r.campaignId === campaign.id);
            const lifetimeStats = { sent: 0, failed: 0, delivered: 0, opened: 0, replied: 0 };

            campaignRuns.forEach(run => {
                const runTracking = tmap.get(run.id);
                if (!runTracking) return;

                // Sum up stats across all channels in this run
                Object.values(runTracking).forEach((channelStats) => {
                    lifetimeStats.sent += channelStats.sent || 0;
                    lifetimeStats.failed += channelStats.failed || 0;
                    lifetimeStats.delivered += channelStats.delivered || 0;
                    lifetimeStats.opened += channelStats.opened || 0;
                    lifetimeStats.replied += channelStats.replied || 0;
                });
            });

            return {
                ...campaign,
                lifetimeStats
            };
        });

        res.json({ success: true, total, currentPage: page, totalPages: Math.ceil(total / limit), data: enrichedData });
    } catch (err) {
        fail(err, next);
    }
};

// GET /campaigns/:id  (includes customerIds so the edit form can pre-select them)
export const getCampaignById = async (req, res, next) => {
    try {
        const campaign = await prisma.outreachCampaign.findFirst({
            where: { id: req.params.id, ...ownedWhere(req.admin) },
            select: { ...LIST_SELECT, customerIds: true },
        });
        if (!campaign) return next(new ApiError(404, "Campaign not found"));
        res.json({ success: true, data: campaign });
    } catch (err) {
        fail(err, next);
    }
};

// PUT /campaigns/:id  (send the full form, same body as create; `status` may be "active" | "paused")
export const updateCampaign = async (req, res, next) => {
    try {
        const existing = await findOwned(req.admin, req.params.id);
        if (!existing) return next(new ApiError(404, "Campaign not found"));
        await assertNotRunning(existing.id);

        const { data, removed } = await parseCampaign(req.admin, req.body);
        const campaign = await prisma.outreachCampaign.update({
            where: { id: existing.id },
            data,
            select: LIST_SELECT,
        });
        res.json({ success: true, removedCustomers: removed, data: campaign });
    } catch (err) {
        fail(err, next);
    }
};

// DELETE /campaigns/:id  (its schedules, runs and logs are deleted with it)
export const deleteCampaign = async (req, res, next) => {
    try {
        const existing = await findOwned(req.admin, req.params.id);
        if (!existing) return next(new ApiError(404, "Campaign not found"));
        await assertNotRunning(existing.id);

        await prisma.outreachCampaign.delete({ where: { id: existing.id } });
        res.json({ success: true, message: "Campaign deleted" });
    } catch (err) {
        fail(err, next);
    }
};