
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";


// ==========================================
// 1. CREATE DRAFT CAMPAIGN
// ==========================================
export const createCampaign = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { name, templateId, targetIds, scheduledAt } = req.body;

        const campaign = await prisma.whatsAppCampaign.create({
            data: {
                adminId,
                name,
                templateId,
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
        const template = await prisma.template.findUnique({ where: { id: campaign?.templateId } });

        if (!campaign || !config || !template) {
            return next(new ApiError(404, "Invalid campaign, template, or Meta configuration."));
        }

        const targetIds = campaign.targetIds;
        if (!Array.isArray(targetIds) || targetIds.length === 0) {
            return next(new ApiError(400, "No recipients selected for this campaign."));
        }

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
        const metaTemplateName = template.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        
        for (const customer of customers) {
            const cleanPhone = customer.ContactNumber.replace(/\D/g, "");
            if (!cleanPhone) continue;

            try {
                // Determine Template Components (Inject Dynamic Name if needed)
                const components = [];
                if (template.body.includes("{{1}}") || template.body.includes("{{Name}}")) {
                    components.push({
                        type: "BODY",
                        parameters: [{ type: "text", text: customer.customerName || "Customer" }]
                    });
                }
                
                // Add Media Headers if template requires it
                if (template.whatsappMediaType === "image" && template.whatsappImage?.length > 0) {
                     components.push({
                         type: "HEADER", parameters: [{ type: "image", image: { link: template.whatsappImage[0] } }]
                     });
                }

                // Send to Meta API
                const metaRes = await fetch(
                    `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`,
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
                                language: { code: "en_US" },
                                components: components.length > 0 ? components : undefined
                            }
                        })
                    }
                );

                const metaData = await metaRes.json();
                
                if (metaData.error) {
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
                            body: `Campaign Sent: ${template.name}`,
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