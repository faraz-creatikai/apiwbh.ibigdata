import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";

const GRAPH = "https://graph.facebook.com/v21.0";

const toMetaName = (name) => name.toLowerCase().replace(/[^a-z0-9_]/g, "_");

// CRM stores media as a JSON array (or a JSON string of one)
const firstMediaUrl = (field) => {
    try {
        const parsed = typeof field === "string" ? JSON.parse(field) : field;
        return Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0] ? parsed[0] : null;
    } catch {
        return typeof field === "string" && field.startsWith("http") ? field : null;
    }
};


// ==========================================
// 1. CREATE DRAFT CAMPAIGN
// ==========================================
// Two ways to pick a template:
//   - templateId   -> a CRM template (existing behaviour, unchanged)
//   - templateName -> a template that is approved in Meta but has no CRM record
//                     (needs the two nullable columns added to WhatsAppCampaign)
export const createCampaign = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { name, templateId, templateName, headerMediaUrl, targetIds, scheduledAt } = req.body;

        if (!name) return next(new ApiError(400, "Campaign name is required."));
        if (!templateId && !templateName) return next(new ApiError(400, "Select a template."));

        const isMetaOnly = !templateId && !!templateName;

        const campaign = await prisma.whatsAppCampaign.create({
            data: {
                adminId,
                name,
                // templateId stays required (the Baileys flow relies on it), so Meta-only
                // templates store a marker here instead of a CRM id.
                templateId: isMetaOnly ? `meta:${templateName}` : templateId,
                ...(isMetaOnly ? { metaTemplateName: templateName, headerMediaUrl: headerMediaUrl || null } : {}),
                targetIds: targetIds || [],
                status: "DRAFT",
                scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
            }
        });

        res.status(201).json({ success: true, campaign });
    } catch (err) {
        console.error("❌ Create Campaign Error:", err.message);
        next(new ApiError(500, "Failed to create campaign draft"));
    }
};

// ==========================================
// 2. GET ALL CAMPAIGNS & SESSIONS
// ==========================================
export const getCampaigns = async (req, res, next) => {
    try {
        const adminId = req.admin.id;

        const campaigns = await prisma.whatsAppCampaign.findMany({
            where: { adminId },
            include: { sessions: { orderBy: { startedAt: 'desc' } } },
            orderBy: { createdAt: 'desc' }
        });

        res.status(200).json({ success: true, campaigns });
    } catch (err) {
        next(new ApiError(500, "Failed to fetch campaigns"));
    }
};

// ==========================================
// 3. START CAMPAIGN (EXECUTE SESSION)
// ==========================================
export const startCampaign = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { campaignId } = req.params;

        const campaign = await prisma.whatsAppCampaign.findUnique({ where: { id: campaignId, adminId } });
        const config = await prisma.whatsAppMetaConfig.findUnique({ where: { adminId } });
        if (!campaign || !config) {
            return next(new ApiError(404, "Invalid campaign or Meta configuration."));
        }

        const isMetaOnly = !!campaign.metaTemplateName;
        const template = isMetaOnly ? null : await prisma.template.findUnique({ where: { id: campaign.templateId } });
        if (!isMetaOnly && !template) {
            return next(new ApiError(404, "Template for this campaign was not found."));
        }

        const targetIds = campaign.targetIds;
        if (!Array.isArray(targetIds) || targetIds.length === 0) {
            return next(new ApiError(400, "No recipients selected for this campaign."));
        }

        // ------------------------------------------
        // Ask Meta for the approved template definition (language, header type, variables).
        // This also stops us from blasting a template that is not approved.
        // ------------------------------------------
        const metaTemplateName = isMetaOnly ? campaign.metaTemplateName : toMetaName(template.name);

        const tplRes = await fetch(
            `${GRAPH}/${config.wabaId}/message_templates?name=${encodeURIComponent(metaTemplateName)}`,
            { headers: { Authorization: `Bearer ${config.accessToken}` } }
        );
        const tplData = await tplRes.json();
        const metaTemplate = tplData.data?.find((t) => t.name === metaTemplateName && t.status === "APPROVED");
        if (!metaTemplate) {
            return next(new ApiError(400, `Template '${metaTemplateName}' is not approved by Meta yet or does not exist.`));
        }

        const languageCode = metaTemplate.language || "en_US";
        const headerDef = metaTemplate.components?.find((c) => c.type === "HEADER");
        const bodyDef = metaTemplate.components?.find((c) => c.type === "BODY");

        // Media header (image / video / document) needs a public link
        let headerComponent = null;
        if (headerDef && headerDef.format !== "TEXT") {
            const fmt = headerDef.format.toLowerCase(); // image | video | document
            const link = isMetaOnly ? campaign.headerMediaUrl : firstMediaUrl(template.whatsappImage);
            if (!link) {
                return next(new ApiError(400, `This template needs a ${fmt} header, but no file link is set for it.`));
            }
            headerComponent = {
                type: "header", // Meta send API expects lowercase
                parameters: [{
                    type: fmt,
                    [fmt]: { link, ...(fmt === "document" ? { filename: template?.whatsappFileName || "Document" } : {}) }
                }]
            };
        }

        const bodyVarCount = (bodyDef?.text?.match(/\{\{[^}]+\}\}/g) || []).length;

        // Fetch valid customers
        const customers = await prisma.customer.findMany({
            where: { id: { in: targetIds } },
            select: { id: true, ContactNumber: true, customerName: true }
        });

        // Create the Analytics Tracking Session
        const session = await prisma.whatsAppCampaignSession.create({
            data: {
                campaignId,
                adminId,
                status: "RUNNING",
                totalRecipients: customers.length
            }
        });

        // Mark campaign as completed if it was a draft
        await prisma.whatsAppCampaign.update({
            where: { id: campaignId },
            data: { status: "COMPLETED" }
        });

        res.status(200).json({ success: true, message: "Campaign started.", sessionId: session.id });

        // ==========================================
        // BACKGROUND PROCESSING: Send Templates
        // ==========================================
        for (const customer of customers) {
            const cleanPhone = customer.ContactNumber.replace(/\D/g, "");
            if (!cleanPhone) continue;

            try {
                const components = [];
                if (headerComponent) components.push(headerComponent);
                if (bodyVarCount > 0) {
                    components.push({
                        type: "body",
                        // {{1}} = customer name, any further variables get a neutral fallback
                        parameters: Array.from({ length: bodyVarCount }, (_, i) => ({
                            type: "text",
                            text: i === 0 ? (customer.customerName || "Customer") : "Details"
                        }))
                    });
                }

                const metaRes = await fetch(
                    `${GRAPH}/${config.phoneNumberId}/messages`,
                    {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${config.accessToken}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            messaging_product: "whatsapp",
                            to: cleanPhone,
                            type: "template",
                            template: {
                                name: metaTemplateName,
                                language: { code: languageCode },
                                components: components.length > 0 ? components : undefined
                            }
                        })
                    }
                );

                const metaData = await metaRes.json();

                if (metaData.error) {
                    console.error(`❌ [CAMPAIGN SEND ERROR] ${cleanPhone}:`, metaData.error.message);
                    await prisma.whatsAppCampaignSession.update({
                        where: { id: session.id }, data: { failed: { increment: 1 } }
                    });
                } else {
                    // Save to DB so Webhooks can track it later
                    await prisma.whatsAppMessage.create({
                        data: {
                            adminId,
                            phoneKey: cleanPhone.slice(-10),
                            waId: metaData.messages[0].id,
                            fromMe: true,
                            type: "template",
                            body: `Campaign Sent: ${template ? template.name : metaTemplateName}`,
                            status: "sent",
                            isRead: true,
                            source: "meta",
                            campaignSessionId: session.id, // 🛑 Links message to Insights Dashboard
                            timestamp: new Date()
                        }
                    });

                    await prisma.whatsAppCampaignSession.update({
                        where: { id: session.id }, data: { sent: { increment: 1 } }
                    });
                }
            } catch (err) {
                console.error("Bulk Send Error for", cleanPhone, err.message);
            }
        }

        // Complete Session
        await prisma.whatsAppCampaignSession.update({
            where: { id: session.id },
            data: { status: "COMPLETED", completedAt: new Date() }
        });

    } catch (err) {
        console.error("Start Campaign Error:", err.message);
        if (!res.headersSent) next(new ApiError(500, "Failed to start campaign"));
    }
};

// ==========================================
// 4. DELETE DRAFT CAMPAIGN
// ==========================================
export const deleteCampaign = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { campaignId } = req.params;

        const campaign = await prisma.whatsAppCampaign.findUnique({
            where: { id: campaignId, adminId },
            include: { sessions: true }
        });

        if (!campaign) return next(new ApiError(404, "Campaign not found."));
        if (campaign.sessions.length > 0) return next(new ApiError(400, "Cannot delete a campaign that has been executed."));

        await prisma.whatsAppCampaign.delete({ where: { id: campaignId } });
        res.status(200).json({ success: true, message: "Campaign deleted." });
    } catch (err) {
        next(new ApiError(500, "Failed to delete campaign"));
    }
};