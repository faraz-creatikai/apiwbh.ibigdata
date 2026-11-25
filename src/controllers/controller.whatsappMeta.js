import { serverUrl } from "../config/cors-origins.js";
import prisma from "../config/prismaClient.js";
import { getSocket } from "../socket/socket.js";
import ApiError from "../utils/ApiError.js";
import { toWaNumber } from "../utils/phone.js";


// Helper to emit events to a specific admin's socket room
const emitToAdmin = (adminId, event, payload) => {
    const io = getSocket();
    if (io) io.to(`admin:${adminId}`).emit(event, payload);
};

// ==========================================
// 1. AUTHENTICATION (Embedded Signup)
// ==========================================
export const connectMetaWhatsapp = async (req, res, next) => {
    try {
        const { code, waba_id, phone_number_id } = req.body;
        const adminId = req.admin.id;

        // 🛑 FIX 1: Relaxed validation. Meta sometimes omits phone_number_id during the coexistence flow.
        if (!code || !waba_id) {
            return next(new ApiError(400, "Missing required Meta OAuth parameters: code or waba_id"));
        }

        console.log(`🔄 [${adminId}] Exchanging WhatsApp OAuth code for token...`);

        // 🛑 FIX 2: Added `&redirect_uri=` at the end. Meta rejects JS SDK codes without this empty parameter.
        const tokenRes = await fetch(
            `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${process.env.FB_APP_ID}&client_secret=${process.env.FB_APP_SECRET}&code=${code}&redirect_uri=`
        );
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.error("Short token error:", tokenData);
            return next(new ApiError(400, "Failed to exchange OAuth code for access token"));
        }

        const longRes = await fetch(
            `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.FB_APP_ID}&client_secret=${process.env.FB_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`
        );
        const longData = await longRes.json();

        if (!longData.access_token) {
            console.error("Long token error:", longData);
            return next(new ApiError(400, "Failed to get long-lived access token"));
        }

        const accessToken = longData.access_token;
        console.log(`✅ [${adminId}] Long-lived WhatsApp Token received`);

        // webhook configure

        const WHATSAPP_WEBHOOK_URL = serverUrl + "/api/social-auth/whatsapp-webhook"
        const subBody = WHATSAPP_WEBHOOK_URL
            ? JSON.stringify({
                override_callback_uri: WHATSAPP_WEBHOOK_URL,
                verify_token: process.env.WHATSAPP_VERIFY_TOKEN || "my_secure_verify_token_123",
            })
            : undefined;

        const subRes = await fetch(`https://graph.facebook.com/v21.0/${waba_id}/subscribed_apps`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                ...(subBody ? { "Content-Type": "application/json" } : {}),
            },
            ...(subBody ? { body: subBody } : {}),
        });
        const subData = await subRes.json();
        if (!subData.success) {
            console.warn(`⚠️ [${adminId}] subscribed_apps failed:`, subData);
        }

        const config = await prisma.whatsAppMetaConfig.upsert({
            where: { adminId },
            update: {
                wabaId: waba_id,
                phoneNumberId: phone_number_id || null, // Allow null if Meta omitted it
                accessToken: accessToken,
                activeProvider: "meta"
            },
            create: {
                adminId,
                wabaId: waba_id,
                phoneNumberId: phone_number_id || null,
                accessToken: accessToken,
                activeProvider: "meta"
            }
        });

        res.status(200).json({
            success: true,
            message: "Official WhatsApp Business connected successfully!",
            config
        });
    } catch (err) {
        console.error("❌ Meta WhatsApp Auth Error:", err.message);
        next(new ApiError(500, "Failed to authenticate WhatsApp account"));
    }
};

// ==========================================
// 2. WEBHOOK VERIFICATION (GET)
// ==========================================
/* export const verifyWhatsAppWebhook = (req, res) => {
    // This token is created by YOU. It must match what you paste in the Meta Developer Dashboard.
    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "my_secure_whatsapp_token_123";

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token) {
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("✅ WhatsApp Webhook verified by Meta");
            return res.status(200).send(challenge);
        } else {
            console.error("❌ WhatsApp Webhook verification failed (Token mismatch)");
            return res.sendStatus(403);
        }
    }
    
    return res.sendStatus(400);
}; */



// GET method to verify the webhook
export const verifyWhatsAppWebhook = (req, res) => {
    // Use a secure string here or load it from your .env file
    const verify_token = process.env.WHATSAPP_VERIFY_TOKEN || "my_secure_verify_token_123";

    // Parse parameters from the webhook verification request
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    // Check if a token and mode were sent
    if (mode && token) {
        if (mode === "subscribe" && token === verify_token) {
            console.log("WhatsApp Webhook Verified successfully!");
            // Respond with 200 OK and challenge token from the request
            return res.status(200).send(challenge);
        } else {
            // Responds with '403 Forbidden' if verify tokens do not match
            return res.sendStatus(403);
        }
    } else {
        return res.sendStatus(400);
    }
};

// ==========================================
// 3. INCOMING MESSAGES & STATUS UPDATES (POST)
// ==========================================
export const receiveWhatsAppMessage = async (req, res) => {
    // 1. ALWAYS return 200 OK immediately
    res.sendStatus(200);

    console.log("🔔 [META WEBHOOK HIT]", JSON.stringify(req.body));

    try {
        const body = req.body;

        if (body.object !== "whatsapp_business_account") return;

        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0]?.value;

        if (!changes) return;

        const phoneNumberId = changes.metadata?.phone_number_id;

        // Ensure we find the config. Use findFirst in case of multiple tests.
        const config = await prisma.whatsAppMetaConfig.findFirst({
            where: { phoneNumberId }
        });

        if (!config) {
            console.log(`⚠️ Received WhatsApp webhook for unknown Phone Number ID: ${phoneNumberId}`);
            return;
        }

        const adminId = config.adminId;

        // ------------------------------------------------
        // A. Handle Status Updates (Sent, Delivered, Read, Failed)
        // ------------------------------------------------
        if (changes.statuses?.length > 0) {
            for (const statusObj of changes.statuses) {
                const waId = statusObj.id;
                const status = statusObj.status;

                console.log("📩 [META STATUS]", {
                    to: statusObj.recipient_id,
                    status,
                    errors: statusObj.errors || null
                });

                const existingMsg = await prisma.whatsAppMessage.findUnique({
                    where: { adminId_waId: { adminId, waId } }
                });

                if (existingMsg) {
                    await prisma.whatsAppMessage.update({
                        where: { id: existingMsg.id },
                        data: { status }
                    });

                    // 🛑 CAMPAIGN ANALYTICS: Increment session metrics
                    if (existingMsg.campaignSessionId) {
                        const metricField = status === "delivered" ? "delivered" : (status === "read" ? "read" : (status === "failed" ? "failed" : null));
                        if (metricField) {
                            await prisma.whatsAppCampaignSession.update({
                                where: { id: existingMsg.campaignSessionId },
                                data: { [metricField]: { increment: 1 } }
                            });
                        }
                    }

                    emitToAdmin(adminId, "whatsapp:message_status", { waId, status });
                }
            }
        }

        // ------------------------------------------------
        // B. Handle Incoming Messages (Text, Image, etc.)
        // ------------------------------------------------
        if (changes.messages?.length > 0) {
            for (const msg of changes.messages) {
                const waId = msg.id;
                const fromPhone = msg.from;
                const phoneKey = fromPhone.slice(-10);
                const type = msg.type;

                let messageBody = "";
                let mediaUrl = null;

                if (type === "text") {
                    messageBody = msg.text?.body || "";
                } else if (type === "button") {
                    messageBody = msg.button?.text || "";
                } else if (type === "interactive") {
                    messageBody = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
                } else if (["image", "video", "audio", "document", "sticker"].includes(type)) {
                    messageBody = msg[type]?.caption || `[${type}]`;
                    mediaUrl = msg[type]?.id || null;
                } else {
                    messageBody = `[${type}]`;
                }

                const exists = await prisma.whatsAppMessage.findUnique({
                    where: { adminId_waId: { adminId, waId } }
                });

                if (exists) continue;

                const savedMsg = await prisma.whatsAppMessage.create({
                    data: {
                        adminId, phoneKey, waId, fromMe: false,
                        type: type === "button" ? "text" : type,
                        body: messageBody, status: "delivered", isRead: false,
                        source: "meta", mediaUrl,
                        timestamp: new Date(Number(msg.timestamp) * 1000),
                    }
                });

                // 🛑 CAMPAIGN ANALYTICS: Detect if this is a reply to a campaign
                const recentCampaignMsg = await prisma.whatsAppMessage.findFirst({
                    where: { adminId, phoneKey, fromMe: true, campaignSessionId: { not: null } },
                    orderBy: { timestamp: 'desc' }
                });

                if (recentCampaignMsg && recentCampaignMsg.campaignSessionId) {
                    await prisma.whatsAppCampaignSession.update({
                        where: { id: recentCampaignMsg.campaignSessionId },
                        data: { replied: { increment: 1 } }
                    });
                }

                emitToAdmin(adminId, "whatsapp:message", savedMsg);
            }
        }
    } catch (error) {
        console.error("❌ Error processing WhatsApp Webhook:", error.message);
    }
};


// ==========================================
// 4. CHECK CONNECTION STATUS (GET)
// ==========================================
export const checkWhatsAppConnection = async (req, res, next) => {
    try {
        const adminId = req.admin.id;

        const config = await prisma.whatsAppMetaConfig.findUnique({
            where: { adminId }
        });

        if (config && config.activeProvider === "meta") {
            // 1. Fetch phone number details (verified name, display number, quality rating)
            const phoneRes = await fetch(
                `https://graph.facebook.com/v21.0/${config.phoneNumberId}?fields=verified_name,display_phone_number,quality_rating&access_token=${config.accessToken}`
            );
            const phoneData = await phoneRes.json();

            if (phoneData.error) {
                console.error("Meta Phone API Error:", phoneData.error.message);
                return res.status(200).json({ connected: false });
            }

            // 2. Fetch business profile details (profile picture, about) from the correct sub-endpoint
            const profileRes = await fetch(
                `https://graph.facebook.com/v21.0/${config.phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url,about&access_token=${config.accessToken}`
            );
            const profileData = await profileRes.json();

            // Extract profile picture safely (profileData.data[0] contains the profile object)
            const profilePictureUrl = profileData.data?.[0]?.profile_picture_url || null;

            return res.status(200).json({
                connected: true,
                config,
                accountDetails: {
                    name: phoneData.verified_name || "WhatsApp Business Account",
                    phone: phoneData.display_phone_number || "Unknown Number",
                    profilePicture: profilePictureUrl,
                    qualityRating: phoneData.quality_rating || "UNKNOWN"
                }
            });
        }

        return res.status(200).json({ connected: false });
    } catch (err) {
        console.error("❌ Check Connection Error:", err.message);
        next(new ApiError(500, "Failed to check WhatsApp connection status"));
    }
};


// ==========================================
// 5. DISCONNECT WHATSAPP (DELETE)
// ==========================================
export const disconnectMetaWhatsapp = async (req, res, next) => {
    try {
        const adminId = req.admin.id;

        // Check if config exists before deleting to avoid Prisma throw
        const existingConfig = await prisma.whatsAppMetaConfig.findUnique({
            where: { adminId }
        });

        if (!existingConfig) {
            return res.status(404).json({ success: false, message: "No WhatsApp connection found." });
        }

        await prisma.whatsAppMetaConfig.delete({
            where: { adminId }
        });

        console.log(`🔌 [${adminId}] WhatsApp configuration deleted.`);
        res.status(200).json({ success: true, message: "WhatsApp disconnected successfully." });
    } catch (err) {
        console.error("❌ Disconnect Error:", err.message);
        next(new ApiError(500, "Failed to disconnect WhatsApp account"));
    }
};




// ==========================================
// 6. SEND MESSAGE (POST)
// ==========================================
export const sendMetaWhatsAppMessage = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { toPhone, messageBody } = req.body;

        if (!toPhone || !messageBody?.trim()) {
            return next(new ApiError(400, "Phone number and message body are required."));
        }

        const config = await prisma.whatsAppMetaConfig.findUnique({
            where: { adminId }
        });

        if (!config || config.activeProvider !== "meta" || !config.accessToken || !config.phoneNumberId) {
            return next(new ApiError(400, "Official WhatsApp is not configured or active."));
        }

        const cleanPhone = toWaNumber(toPhone);
        if (!cleanPhone) {
            return next(new ApiError(400, "Invalid phone number."));
        }

        const trimmedBody = messageBody.trim();

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
                    recipient_type: "individual",
                    to: cleanPhone,
                    type: "text",
                    text: { preview_url: false, body: trimmedBody }
                })
            }
        );

        const metaData = await metaRes.json();
        const isFailed = Boolean(metaData.error || !metaData.messages?.[0]?.id);

        if (isFailed) {
            console.error("❌ Meta Send API Error:", metaData.error);
        }

        // Always persist in DB (both "sent" and "failed") so it shows in chat history
        const savedMsg = await prisma.whatsAppMessage.create({
            data: {
                adminId,
                phoneKey: cleanPhone.slice(-10),
                waId: isFailed
                    ? `failed_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
                    : metaData.messages[0].id,
                fromMe: true,
                type: "text",
                body: trimmedBody,
                status: isFailed ? "failed" : "sent",
                isRead: true,
                source: "meta",
                timestamp: new Date()
            }
        });

        emitToAdmin(adminId, "whatsapp:message", savedMsg);

        return res.status(200).json({
            success: !isFailed,
            message: savedMsg,
            data: savedMsg,
            ...(isFailed ? { error: metaData.error?.message || "Failed to send message via Meta" } : {})
        });
    } catch (error) {
        console.error("❌ Send Meta Message Error:", error.message);
        next(new ApiError(500, "Internal server error while sending WhatsApp message"));
    }
};




// ==========================================
// 7. GET META INBOX SUMMARY (GET)
// ==========================================
export const getMetaInboxSummary = async (req, res, next) => {
    try {
        const adminId = req.admin.id;

        // Fetch all Meta messages for this admin, ordered by newest first
        const messages = await prisma.whatsAppMessage.findMany({
            where: { adminId, source: "meta" },
            orderBy: { timestamp: "desc" }
        });

        // Group by phoneKey to get the latest message and unread count per contact
        const chatMap = new Map();

        for (const msg of messages) {
            if (!chatMap.has(msg.phoneKey)) {
                chatMap.set(msg.phoneKey, {
                    phoneKey: msg.phoneKey,
                    body: msg.body,
                    type: msg.type,
                    fromMe: msg.fromMe,
                    timestamp: msg.timestamp,
                    unread: 0
                });
            }
            // Increment unread count if it's an incoming, unread message
            if (!msg.fromMe && !msg.isRead) {
                chatMap.get(msg.phoneKey).unread += 1;
            }
        }

        res.status(200).json({ success: true, chats: Array.from(chatMap.values()) });
    } catch (err) {
        console.error("❌ Get Meta Inbox Summary Error:", err.message);
        next(new ApiError(500, "Failed to load inbox summary"));
    }
};

// ==========================================
// 8. GET META CHAT HISTORY (GET)
// ==========================================
export const getMetaChatHistory = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { phoneKey } = req.params;

        const messages = await prisma.whatsAppMessage.findMany({
            where: { adminId, phoneKey, source: "meta" },
            orderBy: { timestamp: "asc" }
        });

        res.status(200).json({ success: true, messages });
    } catch (err) {
        console.error("❌ Get Meta Chat History Error:", err.message);
        next(new ApiError(500, "Failed to load chat history"));
    }
};

// ==========================================
// 9. MARK META CHAT AS READ (POST)
// ==========================================
export const markMetaChatRead = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { phoneKey } = req.params;

        await prisma.whatsAppMessage.updateMany({
            where: { adminId, phoneKey, source: "meta", fromMe: false, isRead: false },
            data: { isRead: true }
        });

        res.status(200).json({ success: true });
    } catch (err) {
        console.error("❌ Mark Meta Chat Read Error:", err.message);
        next(new ApiError(500, "Failed to mark messages as read"));
    }
};



// templates

// ==========================================
// 11. GET META TEMPLATES STATUS (GET)
// ==========================================
export const getMetaTemplates = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const config = await prisma.whatsAppMetaConfig.findUnique({ where: { adminId } });

        if (!config || config.activeProvider !== "meta" || !config.wabaId) {
            return res.status(200).json({ success: true, metaTemplates: [] });
        }

        // Fetch all templates associated with this WhatsApp Business Account
        const metaRes = await fetch(
            `https://graph.facebook.com/v21.0/${config.wabaId}/message_templates?access_token=${config.accessToken}`
        );
        const data = await metaRes.json();

        if (data.error) throw new Error(data.error.message);

        res.status(200).json({ success: true, metaTemplates: data.data || [] });
    } catch (err) {
        console.error("❌ Get Meta Templates Error:", err.message);
        next(new ApiError(500, "Failed to fetch templates from Meta"));
    }
};



// ==========================================
// HELPER: Extract Media URL from JSON string
// ==========================================
const getFirstMediaUrl = (imageField) => {
    try {
        const parsed = typeof imageField === "string" ? JSON.parse(imageField) : imageField;
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
        return null;
    } catch {
        return null;
    }
};

// ==========================================
// HELPER: Upload Media to Meta using APP ACCESS TOKEN
// ==========================================
const uploadSampleToMeta = async (mediaUrl) => {
    try {
        const appId = process.env.FB_APP_ID;
        const appSecret = process.env.FB_APP_SECRET;

        // 🛑 FIX: Use the universal App Access Token for the App-level upload endpoint
        const appAccessToken = `${appId}|${appSecret}`;

        // 1. Fetch media from Cloudinary
        const imgRes = await fetch(mediaUrl);
        const buffer = await imgRes.arrayBuffer();
        const fileLength = buffer.byteLength;
        const fileType = imgRes.headers.get("content-type") || "image/png";

        // 2. Create Upload Session
        const sessionRes = await fetch(
            `https://graph.facebook.com/v21.0/${appId}/uploads?file_length=${fileLength}&file_type=${fileType}`,
            {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${appAccessToken}` }
            }
        );
        const sessionData = await sessionRes.json();

        if (!sessionData.id) {
            console.error("Meta Session Error:", sessionData);
            return null;
        }

        // 3. Upload the actual file bytes
        const uploadRes = await fetch(
            `https://graph.facebook.com/v21.0/${sessionData.id}`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `OAuth ${appAccessToken}`,
                    'file_offset': '0'
                },
                body: buffer
            }
        );
        const uploadData = await uploadRes.json();

        return uploadData.h || null; // Returns the required header_handle
    } catch (err) {
        console.error("Meta Media Upload Error:", err);
        return null;
    }
};

// ==========================================
// 12. SUBMIT CRM TEMPLATES TO META (POST) - BULK CAPABLE
// ==========================================
export const verifyMetaTemplate = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { templateId, templateIds } = req.body;

        const idsToVerify = templateIds || (templateId ? [templateId] : []);

        if (idsToVerify.length === 0) {
            return next(new ApiError(400, "Please provide at least one template ID."));
        }

        const config = await prisma.whatsAppMetaConfig.findUnique({ where: { adminId } });
        if (!config || !config.wabaId) {
            return next(new ApiError(400, "Meta WhatsApp is not configured."));
        }

        const results = [];

        for (const id of idsToVerify) {
            const crmTemplate = await prisma.template.findUnique({ where: { id } });
            if (!crmTemplate) continue;

            const metaName = crmTemplate.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

            // 1. Sanitize Variables
            let metaBodyText = crmTemplate.body;
            let exampleData = [];

            const varMatches = metaBodyText.match(/\{\{(.+?)\}\}/g);
            if (varMatches) {
                varMatches.forEach((match, index) => {
                    metaBodyText = metaBodyText.replace(match, `{{${index + 1}}}`);
                    exampleData.push("Example" + (index + 1));
                });
            }

            const components = [{
                type: "BODY",
                text: metaBodyText
            }];

            if (exampleData.length > 0) {
                components[0].example = { body_text: [exampleData] };
            }

            // 2. Handle Media Headers safely using the App Access Token Upload helper
            const mediaUrl = getFirstMediaUrl(crmTemplate.whatsappImage);

            if (crmTemplate.whatsappMediaType === "image" && mediaUrl) {
                // 🛑 FIX: Call helper without passing the client token
                const handle = await uploadSampleToMeta(mediaUrl);
                if (handle) {
                    components.push({
                        type: "HEADER",
                        format: "IMAGE",
                        example: { header_handle: [handle] }
                    });
                } else {
                    results.push({ id, name: crmTemplate.name, success: false, error: "Failed to upload image sample to Meta." });
                    continue;
                }
            } else if (crmTemplate.whatsappMediaType === "document" && mediaUrl) {
                const handle = await uploadSampleToMeta(mediaUrl);
                if (handle) {
                    components.push({
                        type: "HEADER",
                        format: "DOCUMENT",
                        example: { header_handle: [handle] }
                    });
                } else {
                    results.push({ id, name: crmTemplate.name, success: false, error: "Failed to upload document sample to Meta." });
                    continue;
                }
            }

            // 3. Send Payload to Meta (using the client's token for template creation)
            const payload = {
                name: metaName,
                category: "MARKETING",
                language: "en_US",
                components
            };

            const metaRes = await fetch(
                `https://graph.facebook.com/v21.0/${config.wabaId}/message_templates`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${config.accessToken}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(payload)
                }
            );

            const data = await metaRes.json();

            if (data.error) {
                console.error(`\n❌ [META REJECTION] Template: ${crmTemplate.name}`);
                console.error(JSON.stringify(data.error, null, 2));

                let deepError = data.error.message;
                if (data.error.error_user_msg) deepError += ` - ${data.error.error_user_msg}`;

                results.push({ id, name: crmTemplate.name, success: false, error: deepError });
            } else {
                results.push({ id, name: crmTemplate.name, success: true, error: null });
            }
        }

        res.status(200).json({
            success: true,
            message: `Processed ${idsToVerify.length} template(s) for verification.`,
            results
        });
    } catch (err) {
        console.error("❌ Verify Template Error:", err.message);
        next(new ApiError(500, "Internal server error while submitting templates"));
    }
};



const DEFAULT_MIME = {
    image: "image/jpeg",
    video: "video/mp4",
    document: "application/pdf",
};

export const uploadMetaSampleToMediaId = async (sampleUrl, fmt, config, fileName = "file") => {
    const dlRes = await fetch(sampleUrl);
    if (!dlRes.ok) {
        throw new Error(`Could not fetch Meta sample ${fmt} (HTTP ${dlRes.status}).`);
    }

    const mimeType = dlRes.headers.get("content-type")?.split(";")[0]?.trim() || DEFAULT_MIME[fmt] || "application/octet-stream";
    const buffer = await dlRes.arrayBuffer();

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([buffer], { type: mimeType }), fileName);

    const upRes = await fetch(`https://graph.facebook.com/v21.0/${config.phoneNumberId}/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.accessToken}` },
        body: form,
    });
    const upData = await upRes.json();

    if (upData.error || !upData.id) {
        throw new Error(upData.error?.message || "Failed to upload template media to Meta.");
    }

    return upData.id;
};




// ==========================================
// SEND META TEMPLATE MESSAGE (Direct/Quick Send)
// ==========================================
export const sendMetaTemplateMessage = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { toPhone, targetIds, templateId, templateName, headerMediaUrl } = req.body;

        const config = await prisma.whatsAppMetaConfig.findUnique({ where: { adminId } });
        if (!config || config.activeProvider !== "meta") {
            return next(new ApiError(400, "WhatsApp not configured."));
        }

        let metaTemplateName = templateName;
        let crmTemplate = null;

        if (templateId) {
            crmTemplate = await prisma.template.findUnique({ where: { id: templateId } });
            if (!crmTemplate) return next(new ApiError(404, "Template not found."));
            metaTemplateName = crmTemplate.name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
        }

        if (!metaTemplateName) {
            return next(new ApiError(400, "Template is required."));
        }

        // 1. Fetch approved template definition from Meta
        const templatesRes = await fetch(
            `https://graph.facebook.com/v21.0/${config.wabaId}/message_templates?name=${encodeURIComponent(metaTemplateName)}&access_token=${config.accessToken}`
        );
        const templatesData = await templatesRes.json();

        const metaTempObj = templatesData.data?.find(
            (t) => t.name === metaTemplateName && t.status === "APPROVED"
        );

        if (!metaTempObj) {
            return next(
                new ApiError(400, `Template '${metaTemplateName}' is not approved by Meta yet or does not exist.`)
            );
        }

        const exactLanguageCode = metaTempObj.language || "en_US";
        const headerDef = metaTempObj.components?.find((c) => c.type === "HEADER");
        const bodyDef = metaTempObj.components?.find((c) => c.type === "BODY");

        // 2. Validate & pre-build HEADER component from Meta's definition
        let staticHeaderComponent = null;
        let headerTextVars = [];

        if (headerDef) {
            const fmt = (headerDef.format || "TEXT").toUpperCase();

            if (["IMAGE", "VIDEO", "DOCUMENT"].includes(fmt)) {
                const lowerFmt = fmt.toLowerCase();
                const publicLink =
                    headerMediaUrl ||
                    (crmTemplate ? getFirstMediaUrl(crmTemplate.whatsappImage) : null);
                const fileName = crmTemplate?.whatsappFileName || "Document";

                let mediaObj = null;

                if (publicLink) {
                    mediaObj = { link: publicLink };
                } else {
                    const sampleUrl = headerDef.example?.header_handle?.[0];
                    if (!sampleUrl || !sampleUrl.startsWith("http")) {
                        return next(
                            new ApiError(400, `This template requires a ${lowerFmt} header, and no sample media was returned by Meta.`)
                        );
                    }
                    try {
                        const mediaId = await uploadMetaSampleToMediaId(sampleUrl, lowerFmt, config, fileName);
                        mediaObj = { id: mediaId };
                    } catch (mediaErr) {
                        return next(new ApiError(400, mediaErr.message));
                    }
                }

                if (lowerFmt === "document") {
                    mediaObj.filename = fileName;
                }

                staticHeaderComponent = {
                    type: "header",
                    parameters: [
                        {
                            type: lowerFmt,
                            [lowerFmt]: mediaObj
                        }
                    ]
                };
            } else if (fmt === "TEXT" && headerDef.text) {
                headerTextVars = headerDef.text.match(/\{\{[^}]+\}\}/g) || [];
            }
        }

        const bodyVars = (bodyDef?.text || "").match(/\{\{[^}]+\}\}/g) || [];
        const isNamedParams = metaTempObj.parameter_format === "NAMED";

        const buildTextParam = (token, index, customerName) => {
            const param = {
                type: "text",
                text: index === 0 ? (customerName || "Customer") : "Details"
            };
            if (isNamedParams) {
                param.parameter_name = token.replace(/^\{\{|\}\}$/g, "").trim();
            }
            return param;
        };

        // 3. Build unique recipient list (supports single toPhone and/or bulk targetIds)
        const targetMap = new Map();

        if (Array.isArray(targetIds) && targetIds.length > 0) {
            const uniqueIds = [...new Set(targetIds.map(String))];
            const customers = await prisma.customer.findMany({
                where: { id: { in: uniqueIds } },
                select: { id: true, ContactNumber: true, CountryCode: true, customerName: true }
            });

            for (const c of customers) {
                const phone = toWaNumber(c.ContactNumber, c.CountryCode);
                if (phone) {
                    targetMap.set(phone, {
                        phone,
                        name: c.customerName || "Customer"
                    });
                }
            }
        }

        if (toPhone) {
            const phone = toWaNumber(toPhone);
            if (phone && !targetMap.has(phone)) {
                targetMap.set(phone, { phone, name: "Customer" });
            }
        }

        const targets = Array.from(targetMap.values());
        if (targets.length === 0) {
            return next(new ApiError(400, "No valid phone numbers provided."));
        }

        // 4. Send to each recipient
        let sentCount = 0;
        const errors = [];

        for (const target of targets) {
            const components = [];

            if (staticHeaderComponent) {
                components.push(staticHeaderComponent);
            } else if (headerTextVars.length > 0) {
                components.push({
                    type: "header",
                    parameters: headerTextVars.map((tok, i) => buildTextParam(tok, i, target.name))
                });
            }

            if (bodyVars.length > 0) {
                components.push({
                    type: "body",
                    parameters: bodyVars.map((tok, i) => buildTextParam(tok, i, target.name))
                });
            }

            const payload = {
                messaging_product: "whatsapp",
                to: target.phone,
                type: "template",
                template: {
                    name: metaTemplateName,
                    language: { code: exactLanguageCode },
                    ...(components.length > 0 ? { components } : {})
                }
            };

            try {
                const metaRes = await fetch(
                    `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`,
                    {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${config.accessToken}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(payload)
                    }
                );

                const metaData = await metaRes.json();

                if (metaData.error) {
                    console.error(`\n❌ [META SEND ERROR] to ${target.phone}:`, JSON.stringify(metaData.error, null, 2));
                    errors.push({ phone: target.phone, error: metaData.error.message });
                } else {
                    sentCount++;
                    await prisma.whatsAppMessage.create({
                        data: {
                            adminId,
                            phoneKey: target.phone.slice(-10),
                            waId: metaData.messages[0].id,
                            fromMe: true,
                            type: "template",
                            body: crmTemplate ? crmTemplate.body : `Template Sent: ${metaTemplateName}`,
                            status: "sent",
                            isRead: true,
                            source: "meta",
                            timestamp: new Date()
                        }
                    });
                }
            } catch (sendErr) {
                console.error(`\n❌ [META REQUEST CRASH] to ${target.phone}:`, sendErr.message);
                errors.push({ phone: target.phone, error: sendErr.message });
            }
        }

        res.status(200).json({
            success: sentCount > 0,
            sentCount,
            failedCount: errors.length,
            message: `Template sent to ${sentCount} of ${targets.length} recipient(s).`,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error("❌ Send Template Controller Error:", error);
        next(new ApiError(500, "Failed to send template."));
    }
};







//admin connect

// ==========================================
// 1b. CONNECT ADMIN'S OWN WABA (manual credentials, no Embedded Signup)
// ==========================================
export const connectMetaWhatsappAdmin = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { wabaId, phoneNumberId, accessToken } = req.body;

        if (!wabaId || !phoneNumberId || !accessToken) {
            return next(new ApiError(400, "wabaId, phoneNumberId and accessToken are required"));
        }

        // Optional allow-list: META_MANUAL_CONNECT_ADMIN_IDS=1,2,3 (leave unset to allow any logged-in admin)
        const allowed = (process.env.META_MANUAL_CONNECT_ADMIN_IDS || "")
            .split(",").map((s) => s.trim()).filter(Boolean);
        if (allowed.length && !allowed.includes(String(adminId))) {
            return next(new ApiError(403, "You are not allowed to use manual WhatsApp connection"));
        }

        const headers = { Authorization: `Bearer ${accessToken}` };
        const GRAPH = "https://graph.facebook.com/v21.0";

        // 1. Validate the token + phone number
        const phoneRes = await fetch(`${GRAPH}/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating`, { headers });
        const phoneData = await phoneRes.json();
        if (phoneData.error) {
            return next(new ApiError(400, `Meta rejected the credentials: ${phoneData.error.message}`));
        }

        // 2. Make sure this phone number really belongs to the given WABA
        const listRes = await fetch(`${GRAPH}/${wabaId}/phone_numbers?fields=id&limit=50`, { headers });
        const listData = await listRes.json();
        if (listData.error) {
            return next(new ApiError(400, `Could not read WABA: ${listData.error.message}`));
        }
        if (!(listData.data || []).some((p) => p.id === String(phoneNumberId))) {
            return next(new ApiError(400, "This phone number does not belong to the given WABA"));
        }


        // 3. Subscribe the app to the WABA (with per-CRM webhook override if configured)
        const WHATSAPP_WEBHOOK_URL = serverUrl + "/api/social-auth/whatsapp-webhook"
        const subBody = WHATSAPP_WEBHOOK_URL
            ? JSON.stringify({
                override_callback_uri: WHATSAPP_WEBHOOK_URL,
                verify_token: process.env.WHATSAPP_VERIFY_TOKEN || "my_secure_verify_token_123",
            })
            : undefined;

        const subRes = await fetch(`${GRAPH}/${wabaId}/subscribed_apps`, {
            method: "POST",
            headers: { ...headers, ...(subBody ? { "Content-Type": "application/json" } : {}) },
            ...(subBody ? { body: subBody } : {}),
        });
        const subData = await subRes.json();
        if (!subData.success) {
            console.warn(`⚠️ [${adminId}] subscribed_apps failed:`, subData);
        }

        // 4. Save, same shape as the Embedded Signup flow
        const config = await prisma.whatsAppMetaConfig.upsert({
            where: { adminId },
            update: { wabaId, phoneNumberId, accessToken, activeProvider: "meta" },
            create: { adminId, wabaId, phoneNumberId, accessToken, activeProvider: "meta" },
        });

        res.status(200).json({
            success: true,
            message: `Connected ${phoneData.display_phone_number} (${phoneData.verified_name})`,
            webhookSubscribed: !!subData.success,
            config: { ...config, accessToken: undefined }, // never echo the token back
        });
    } catch (err) {
        console.error("❌ Meta WhatsApp Admin Connect Error:", err.message);
        next(new ApiError(500, "Failed to connect admin WhatsApp account"));
    }
};