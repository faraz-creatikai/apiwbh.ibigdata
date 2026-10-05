import prisma from '../config/prismaClient.js';
import { sendBaileysWhatsApp } from '../config/twilio.js';
import { prepareCallingInstruction } from '../jobs/sarvamAgentService.js';


const CUSTOMER_SELECT = {
    id: true, customerName: true, ContactNumber: true, Campaign: true, CustomerType: true,
    CustomerSubType: true, LeadType: true, LeadTemperature: true, City: true, Location: true,
    SubLocation: true, Area: true, Price: true, Facillities: true, Description: true,
    Other: true, DealClosed: true,
};


export const triggerSarvamCall = async (req, res, next) => {
    try {
        // ---------------------------------------------------------
        // 1. Read environment variables
        // ---------------------------------------------------------

        const cfg = {
            apiKey: process.env.VOICE_AGENT_API_KEY?.trim(),

            orgId: process.env.SARVAM_ORG_ID?.trim(),

            workspaceId: process.env.SARVAM_WORKSPACE_ID?.trim(),

            appId: process.env.SARVAM_APP_ID?.trim(),

            connectionId: process.env.SARVAM_CONNECTION_ID?.trim(),

            agentPhoneNumber: process.env.SARVAM_CALLER_NUMBER?.trim(),

            webhookBase: process.env.WEBHOOK_BASE_URL
                ?.trim()
                .replace(/\/$/, ""),
        };

        const missing = Object.entries(cfg)
            .filter(([, value]) => !value)
            .map(([key]) => key);

        if (missing.length) {
            console.error("Missing Sarvam env vars:", missing);

            return res.status(500).json({
                message: "Server misconfigured",
                missing,
            });
        }

        console.log(
            `Sarvam key: len=${cfg.apiKey.length}, prefix=${cfg.apiKey.slice(0, 3)}`
        );

        // ---------------------------------------------------------
        // 2. Request body
        // ---------------------------------------------------------

        const { userPrompt, customerId, promptMode, voice } = req.body;

        if (!userPrompt || !customerId) {
            return res.status(400).json({
                message: "userPrompt and customerId are required",
            });
        }

        // Optional voice: only used when the frontend sends one
        let speaker = null;
        if (voice !== undefined && voice !== null && String(voice).trim() !== "") {
            speaker = String(voice).trim().toLowerCase(); // Sarvam speaker ids are lowercase
            if (!/^[a-z][a-z0-9_-]{1,30}$/.test(speaker)) {
                return res.status(400).json({ message: "Invalid voice" });
            }
        }
        // ---------------------------------------------------------
        // 3. Get customer (only the fields the agent needs)
        // ---------------------------------------------------------

        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: CUSTOMER_SELECT, // Password, images and site plans are never loaded
        });

        if (!customer) {
            return res.status(404).json({ message: "Customer not found" });
        }

        // ---------------------------------------------------------
        // 4. Customer phone number (checked before any AI call)
        // ---------------------------------------------------------

        const userPhoneNumber = String(customer.ContactNumber || "").trim();

        if (!userPhoneNumber) {
            return res.status(400).json({
                message: "Customer does not have a contact number",
            });
        }

        const formattedPhone = userPhoneNumber.startsWith("+")
            ? userPhoneNumber
            : `+91${userPhoneNumber}`;

        // ---------------------------------------------------------
        // 5. Get latest followups (newest first, max 5)
        // ---------------------------------------------------------

        const followups = await prisma.followup.findMany({
            where: { customerId },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: {
                StartDate: true,
                StatusType: true,
                FollowupNextDate: true,
                Description: true,
            },
        });

        // ---------------------------------------------------------
        // 6. Prepare calling instructions
        //    callingPrompt / aiAnswer -> shown in the UI (same as before)
        //    agentPrompt              -> sent to the voice agent
        // ---------------------------------------------------------

        const agentInstructions = await prepareCallingInstruction({
            customer,
            followups,
            userPrompt,
            promptMode,
        });

        // ---------------------------------------------------------
        // 7. Instant Outbound API
        // ---------------------------------------------------------

        const url =
            `https://apps.sarvam.ai/api/outbounds/v1` +
            `/orgs/${cfg.orgId}` +
            `/workspaces/${cfg.workspaceId}` +
            `/outbounds`;

        console.log("Sarvam instant outbound URL:", url);

        // ---------------------------------------------------------
        // 8. Create outbound call
        // ---------------------------------------------------------

        const response = await fetch(url, {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
                "X-API-Key": cfg.apiKey,
            },

            body: JSON.stringify({
                app_config: {
                    app_id: cfg.appId,

                    // Use the committed agent version.
                    // Change this if your current committed version
                    // is different.
                    app_version: 12,

                    connection_config: {
                        connection_id: cfg.connectionId,

                        // THIS was the missing field
                        agent_phone_number: cfg.agentPhoneNumber,
                    },

                    // Dynamic variables available to the agent (same names as before)
                    agent_variables: {
                        customer_name: customer.customerName,

                        dynamic_instruction:
                            agentInstructions.agentPrompt,

                        customer_id: customer.id,

                        user_prompt: userPrompt,
                    },

                    app_type: "agent",
                    app_overrides:{
                        // 1. Voice override (if selected in UI)
                        ...(speaker && { text_to_speech_config: { speaker_name: speaker } }),
                        
                        // 2. Strict cost-control boundaries
                     /*    conversation_config: {
                            // Failsafe: Hard cut-off at 3 minutes (180 seconds). 
                            // Adjust this based on your ideal sales pitch length.
                            max_duration_seconds: 180, 
                            
                            // Failsafe: Hang up if the user is completely silent for 15 seconds
                            idle_timeout_seconds: 15,
                        }, */
                        
                        // 3. Drop the call immediately if it hits a voicemail box
                        telephony_config: {
                            answering_machine_detection: "hangup" 
                        }
                    }
                },

                user_config: {
                    user_phone_number: formattedPhone,
                },

                webhook_config: {
                    url: cfg.webhookBase,

                    metadata: {
                        customer_id: customer.id,
                    },
                },
            }),
        });

        // ---------------------------------------------------------
        // 9. Parse Sarvam response
        // ---------------------------------------------------------

        const sarvamText = await response.text();

        let sarvamData;

        try {
            sarvamData = JSON.parse(sarvamText);
        } catch {
            sarvamData = {
                raw_response: sarvamText,
            };
        }

        // ---------------------------------------------------------
        // 10. Handle Sarvam error
        // ---------------------------------------------------------

        if (!response.ok) {
            console.error(
                "Sarvam instant outbound error:",
                response.status,
                sarvamData
            );

            return res.status(response.status).json({
                message: "Sarvam outbound call rejected",
                details: sarvamData,
            });
        }

        // ---------------------------------------------------------
        // 11. Save call log
        // ---------------------------------------------------------

        const callLogRecord =
            await prisma.sarvamCallLog.create({
                data: {
                    participantIdentity:
                        sarvamData.attempt_id || null,

                    sarvamAppId: cfg.appId,

                    orgId: cfg.orgId,

                    workspaceId: cfg.workspaceId,

                    calledTo: formattedPhone,

                    customerId: customer.id,

                    rawJson: {
                        attempt_id:
                            sarvamData.attempt_id || null,

                        outbound_response:
                            sarvamData,

                        generated_instructions:
                            agentInstructions,

                        phone_number:
                            formattedPhone,

                        agent_phone_number:
                            cfg.agentPhoneNumber,

                        app_id:
                            cfg.appId,

                        connection_id:
                            cfg.connectionId,
                    },
                },
            });

        // ---------------------------------------------------------
        // 12. Return success (same response shape as the old version)
        // ---------------------------------------------------------

        return res.status(200).json({
            success: true,

            message:
                "Sarvam instant outbound call initiated",

            attemptId:
                sarvamData.attempt_id || null,

            aiInstructions: {
                callingPrompt: agentInstructions.callingPrompt,
                aiAnswer: agentInstructions.aiAnswer,
            },

            callLogId:
                callLogRecord.id,

            customerId:
                customer.id,

            calledTo:
                formattedPhone,

            agentPhoneNumber:
                cfg.agentPhoneNumber,

            sarvamData,
        });
    } catch (error) {
        console.error(
            "Sarvam instant outbound call failed:",
            error
        );

        return res.status(500).json({
            message:
                "Internal server error triggering Sarvam outbound call",

            error: error.message,
        });
    }
};


// ---------------------------------------------------------------------------
// Webhook (Sarvam POSTs here after each call attempt)
// ---------------------------------------------------------------------------
export const sarvamCallWebhook = async (req, res) => {
    try {
        const p = req.body || {};
        console.log("SARVAM WEBHOOK RECEIVED:", JSON.stringify(p));

        const attemptId = p.attempt_id;
        if (!attemptId) {
            return res.status(400).json({ message: "attempt_id missing" });
        }

        const existing = await prisma.sarvamCallLog.findFirst({
            where: { participantIdentity: attemptId },
            select: { id: true, calledTo: true, rawJson: true },
        });

        if (!existing) {
            // Still return 200 so Sarvam doesn't retry; the log row was never created.
            console.warn("Webhook for unknown attempt:", attemptId);
            return res.status(200).json({ received: true, updatedRecords: 0 });
        }

        // Duplicate delivery guard
        if (existing.rawJson?.webhook?.attempt_id === attemptId) {
            return res.status(200).json({ received: true, duplicate: true });
        }

        const endTime = new Date(); // webhook fires after the call; Sarvam sends no timestamps
        const duration = p.duration != null ? Math.round(Number(p.duration)) : null;

        const updateData = {
            callDuration: duration,
            endTime,
            ...(duration != null && { startTime: new Date(endTime.getTime() - duration * 1000) }),
            ...(p.interaction_transcript && { transcript: JSON.stringify(p.interaction_transcript) }),
            // Keep what the trigger saved, add the webhook result alongside it
            rawJson: { ...(existing.rawJson || {}), webhook: p },
        };

        const metaCustomerId = p.webhook_config?.metadata?.customer_id;
        if (metaCustomerId) updateData.customerId = metaCustomerId;

        await prisma.sarvamCallLog.update({
            where: { id: existing.id },
            data: updateData,
        });

        // Only message people whose call actually connected
        if (p.status === "connected" && existing.calledTo) {
            const waNumber = existing.calledTo.replace("+", "");
            const waMessage = `Hi! Thank you for speaking with our AI voice agent. Let us know if you have any further questions.`;
            sendBaileysWhatsApp(waNumber, waMessage).catch((err) =>
                console.error(`WhatsApp failed for ${waNumber}:`, err.message)
            );
        }

        return res.status(200).json({ received: true, status: p.status });
    } catch (error) {
        console.error("Sarvam webhook failed:", error);
        return res.status(500).json({ message: "Webhook processing failed", error: error.message });
    }
};


const SARVAM_MEDIA_HOST = "indus.sarvam.ai";
const MAX_REDIRECTS = 5;

const getApiKey = () =>
    process.env.VOICE_AGENT_API_KEY?.trim() || process.env.SARVAM_API_KEY?.trim();

/**
 * Turns whatever Sarvam sent into an absolute https URL the proxy can fetch.
 * Returns null for empty values and for data: URIs (which the proxy can't use).
 */
const toAbsoluteMediaUrl = (raw) => {
    if (!raw || typeof raw !== "string") return null;
    if (raw.startsWith("data:")) return null;
    try {
        return new URL(raw, `https://${SARVAM_MEDIA_HOST}`).href;
    } catch {
        return null;
    }
};

/*
 * ---------------------------------------------------------------------
 * Transcript helpers
 * The /interactions list does not include transcripts. They come from
 *   GET .../{app_id}/transcripts/{interaction_id}   (header: X-API-Key)
 * The response shape is not documented, so it is parsed defensively and
 * normalized to [{ role: "user" | "assistant", content: string }].
 * ---------------------------------------------------------------------
 */
const TRANSCRIPT_LIST_KEYS = ["transcript", "transcripts", "messages", "conversation", "turns", "entries", "history", "items", "data"];
const USER_ROLES = ["user", "customer", "human", "caller", "client"];
const HIDDEN_ROLES = ["system", "tool", "function"];

// Completed calls don't change, so non-empty transcripts are cached in memory
const transcriptCache = new Map();

const extractTranscriptList = (node, depth = 0) => {
    if (Array.isArray(node)) return node;
    if (node && typeof node === "object" && depth < 3) {
        for (const key of TRANSCRIPT_LIST_KEYS) {
            if (node[key] !== undefined) {
                const found = extractTranscriptList(node[key], depth + 1);
                if (found.length) return found;
            }
        }
    }
    return [];
};

const messageText = (value) => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join(" ");
    if (value && typeof value === "object") return messageText(value.text ?? value.content ?? "");
    return "";
};

const normalizeTranscriptMessage = (m) => {
    if (typeof m === "string") return m.trim() ? { role: "assistant", content: m } : null;
    if (!m || typeof m !== "object") return null;

    const content = messageText(m.content ?? m.text ?? m.message ?? m.transcript ?? m.utterance ?? "").trim();
    if (!content) return null;

    const rawRole = String(m.role ?? m.speaker ?? m.sender ?? m.author ?? m.from ?? "").toLowerCase();
    if (HIDDEN_ROLES.includes(rawRole)) return null;

    return { ...m, role: USER_ROLES.includes(rawRole) ? "user" : "assistant", content };
};

const fetchInteractionTranscript = async (baseUrl, apiKey, interactionId) => {
    if (!interactionId) return [];
    if (transcriptCache.has(interactionId)) return transcriptCache.get(interactionId);

    // Ids look like "20261001/708190c5-14:52:06-45a45272": try fully encoded, then slash kept
    const variants = [...new Set([
        encodeURIComponent(interactionId),
        interactionId.split("/").map(encodeURIComponent).join("/"),
    ])];

    let lastStatus = null;
    for (const variant of variants) {
        try {
            const resp = await fetch(`${baseUrl}/transcripts/${variant}`, {
                method: "GET",
                headers: { "X-API-Key": apiKey, Accept: "application/json" },
                signal: AbortSignal.timeout(15000),
            });
            if (!resp.ok) {
                lastStatus = resp.status;
                continue;
            }

            const json = await resp.json().catch(() => null);
            const messages = extractTranscriptList(json).map(normalizeTranscriptMessage).filter(Boolean);

            if (messages.length) {
                transcriptCache.set(interactionId, messages);
            } else {
                const keys = json && typeof json === "object" ? Object.keys(json).join(", ") : typeof json;
                console.warn(`[transcript] ${interactionId}: 200 OK but no messages recognized. top-level: ${keys || "(empty)"}`);
            }
            return messages;
        } catch (e) {
            console.warn(`[transcript] ${interactionId}: request error: ${e.message}`);
        }
    }

    console.warn(`[transcript] ${interactionId}: failed${lastStatus ? ` (HTTP ${lastStatus})` : ""}`);
    return [];
};

// Runs fn over items with at most `limit` requests in flight
const mapWithConcurrency = async (items, limit, fn) => {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const idx = next++;
            results[idx] = await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
    return results;
};




/*
 * =====================================================================
 * GET /sarvam/call-logs  (your existing sync route)
 * Returns lightweight logs. recording_url is the RAW Sarvam media URL,
 * which the frontend passes to fetchSarvamAudio() on demand.
 * =====================================================================
 */




// Last 10 digits, so "+91 78781 72452" and "7878172452" compare equal
const last10 = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);

// Sarvam start_datetime is UTC with no "Z" (e.g. "2026-10-05T09:11:26")
const logTime = (log) => {
    const s = String(log?.start_datetime ?? "");
    if (!s) return NaN;
    return new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`).getTime();
};

const extractInteractions = (rawData) => {
    if (Array.isArray(rawData)) return rawData;
    if (Array.isArray(rawData?.data)) return rawData.data;
    if (Array.isArray(rawData?.interactions)) return rawData.interactions;
    if (Array.isArray(rawData?.items)) return rawData.items;
    return Object.values(rawData || {}).find(Array.isArray) || [];
};

const MAX_ROUNDS = 30; // safety stop: at most 30 requests per sync

// Gets EVERY interaction between start and end, even though Sarvam caps one response.
const fetchAllInteractions = async (baseUrl, apiKey, start, end) => {
    const seen = new Map(); // interaction_id -> log (dedupes overlaps)
    let from = start.getTime();
    let to = end.getTime();
    let direction = null; // "asc" (oldest first) or "desc", detected from the first response
    let firstPageSize = 0;
    let rounds = 0;

    for (; rounds < MAX_ROUNDS; rounds++) {
        const params = new URLSearchParams({
            start_datetime: new Date(from).toISOString(),
            end_datetime: new Date(to).toISOString(),
        });

        const resp = await fetch(`${baseUrl}/interactions?${params.toString()}`, {
            method: "GET",
            headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        });

        if (!resp.ok) {
            const err = new Error("Failed to fetch interactions from Sarvam API");
            err.status = resp.status;
            err.details = await resp.text();
            throw err;
        }

        const page = extractInteractions(await resp.json());
        if (!page.length) break;

        const fresh = page.filter((l) => l.interaction_id && !seen.has(l.interaction_id));
        fresh.forEach((l) => seen.set(l.interaction_id, l));
        if (!fresh.length) break; // nothing new: we have everything

        if (rounds === 0) firstPageSize = page.length;
        // A response smaller than the first (full) one means we reached the end
        if (rounds > 0 && page.length < firstPageSize) break;

        const times = page.map(logTime).filter(Number.isFinite);
        if (!times.length) break;

        if (!direction) {
            const a = logTime(page[0]);
            const b = logTime(page[page.length - 1]);
            direction = a <= b ? "asc" : "desc";
        }

        // Move the window past what we already have (1s overlap, duplicates are ignored)
        if (direction === "asc") from = Math.max(...times) - 1000;
        else to = Math.min(...times) + 1000;
    }

    return { logs: [...seen.values()], rounds: rounds + 1, direction };
};

export const syncSarvamCallLogs = async (req, res) => {
    try {
        const apiKey = getApiKey();
        const orgId = process.env.SARVAM_ORG_ID?.trim();
        const workspaceId = process.env.SARVAM_WORKSPACE_ID?.trim();
        const appId = process.env.SARVAM_APP_ID?.trim();

        if (!apiKey || !orgId || !workspaceId || !appId) {
            return res.status(500).json({
                message: "Sarvam analytics configuration missing",
            });
        }

        // Which customer is the frontend asking about? (both optional)
        const customerId = req.query.customerId ? String(req.query.customerId) : "";
        const targetPhone = last10(req.query.phone);

        const baseUrl = `https://apps.sarvam.ai/api/analytics/v1/${orgId}/${workspaceId}/${appId}`;

        // Last 30 days
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - 30);

        let all;
        try {
            all = await fetchAllInteractions(baseUrl, apiKey, start, end);
        } catch (e) {
            if (e.status) {
                return res.status(e.status).json({ message: e.message, details: e.details });
            }
            throw e;
        }

        let interactions = all.logs;
        const totalFromSarvam = interactions.length;

        // ---- ONLY THIS CUSTOMER'S CALLS (before any transcript is fetched) ----
        // 1. customer_id match wins.
        // 2. Phone match is used only for logs that carry no customer_id
        //    (two customers can share one phone number, e.g. Amit and "test").
       // ---- ONLY THIS CUSTOMER'S CALLS (before any transcript is fetched) ----
        if (customerId || targetPhone) {
            interactions = interactions.filter((log) => {
                
                // 1. Hunt down the customer_id in all known Sarvam payload locations
                const rawCustId = 
                    log.metadata?.customer_id || 
                    log.webhook_config?.metadata?.customer_id || 
                    log.agent_variables?.customer_id || 
                    log.app_config?.agent_variables?.customer_id;

                const logCustId = rawCustId ? String(rawCustId) : "";

                // Match by Customer ID
                if (customerId && logCustId === customerId) {
                    return true;
                }

                // 2. If no customer ID was found in the payload, fallback to Phone matching
                if (!logCustId && targetPhone) {
                    // Hunt down the phone number in all known Sarvam payload locations
                    const rawPhone = 
                        log.user_phone_number || 
                        log.user_contact || 
                        log.user_config?.user_phone_number || 
                        log.phone_number || 
                        log.called_to || 
                        "";
                        
                    return last10(rawPhone) === targetPhone;
                }
                
                return false;
            });
        }

        const finalLogs = await mapWithConcurrency(interactions, 5, async (log) => {
            // Use an inline transcript if the list ever includes one
            let transcriptArray = [];
            if (Array.isArray(log.transcript)) {
                transcriptArray = log.transcript;
            } else if (log.transcript && Array.isArray(log.transcript.messages)) {
                transcriptArray = log.transcript.messages;
            }

            // Otherwise fetch it from the official transcripts endpoint.
            // Skip calls that clearly never connected (0 seconds, 0 messages).
            const neverConnected = log.duration_in_seconds === 0 && !log.num_messages;
            if (!transcriptArray.length && !neverConnected) {
                transcriptArray = await fetchInteractionTranscript(baseUrl, apiKey, log.interaction_id);
            }

            const recordingUrl = toAbsoluteMediaUrl(log.audio_url || log.recording_url);

            return {
                ...log,
                transcript: transcriptArray,
                recording_url: recordingUrl, // raw URL, NOT base64
                has_recording: Boolean(recordingUrl),
            };
        });

        // Debug aid
        const times = all.logs.map(logTime).filter(Number.isFinite);
        console.log(
            `[sync] customer=${customerId || "-"} phone=${targetPhone || "-"} | ` +
            `${totalFromSarvam} from Sarvam in ${all.rounds} request(s), order=${all.direction || "?"}, ` +
            `newest=${times.length ? new Date(Math.max(...times)).toISOString() : "-"} | ` +
            `${finalLogs.length} matched, ` +
            `${finalLogs.filter((l) => l.has_recording).length} with recording, ` +
            `${finalLogs.filter((l) => l.transcript.length > 0).length} with transcript.`
        );

        return res.status(200).json({
            success: true,
            count: finalLogs.length,
            logs: finalLogs,
        });
    } catch (error) {
        console.error("Sarvam call log sync failed:", error);
        return res.status(500).json({
            message: "Internal server error",
            error: error.message,
        });
    }
};


/*
 * =====================================================================
 * GET /sarvam/audio?recordingUrl=<recording_url>
 *
 * The indus.sarvam.ai/media link is a dashboard link and is blocked for
 * server requests (403 from Cloudflare). Instead we read the
 * interaction_id out of that link and call Sarvam's official endpoint:
 *   GET https://apps.sarvam.ai/api/analytics/v1/{org}/{ws}/{app}/recordings/{interaction_id}
 * (header: X-API-Key). The response may be the audio itself or JSON that
 * points to the file, so both are handled.
 * =====================================================================
 */
const ANALYTICS_HOST = "apps.sarvam.ai";
const BROWSER_UA = "Mozilla/5.0 (compatible; VoiceAgentServer/1.0)";

// Turn error bodies (especially HTML block pages) into a short readable string
const summarizeBody = (text) => {
    const t = String(text || "");
    if (/^\s*<(!doctype|html)/i.test(t)) {
        const title = t.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
        return `HTML error page${title ? `: ${title}` : ""}`;
    }
    return t.slice(0, 300);
};

// Detect the real audio format from the file's first bytes
const sniffAudioType = (buf) => {
    const head = buf.subarray(0, 4).toString("latin1");
    if (head === "RIFF") return "audio/wav";
    if (head === "OggS") return "audio/ogg";
    if (head === "fLaC") return "audio/flac";
    if (head.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    if (buf.subarray(4, 8).toString("latin1") === "ftyp") return "audio/mp4";
    return null;
};

// First http(s) URL found anywhere inside a JSON value
const findUrlInJson = (node) => {
    if (typeof node === "string") return /^https?:\/\//i.test(node) ? node : null;
    if (node && typeof node === "object") {
        for (const v of Object.values(node)) {
            const found = findUrlInJson(v);
            if (found) return found;
        }
    }
    return null;
};

// GET with manual redirects. The API key is sent only to Sarvam hosts, never to S3/CDN.
const fetchFollowingRedirects = async (startUrl, apiKey, label) => {
    let current = new URL(startUrl);
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
        const isSarvam = current.hostname === ANALYTICS_HOST || current.hostname === SARVAM_MEDIA_HOST;
        const resp = await fetch(current.href, {
            method: "GET",
            redirect: "manual",
            headers: {
                "User-Agent": BROWSER_UA,
                Accept: "audio/*,application/json;q=0.9,*/*;q=0.8",
                ...(isSarvam ? { "X-API-Key": apiKey } : {}),
            },
        });
        console.log(`[audio] ${label} hop ${i}: ${resp.status} ${current.hostname} (${resp.headers.get("content-type") || "no content-type"})`);

        const location = resp.headers.get("location");
        if (resp.status >= 300 && resp.status < 400 && location) {
            const next = new URL(location, current);
            if (next.protocol !== "https:") throw new Error("Insecure redirect blocked");
            current = next;
            continue;
        }
        return resp;
    }
    throw new Error("Too many redirects");
};

export const streamSarvamAudio = async (req, res) => {
    try {
        const apiKey = getApiKey();
        const orgId = process.env.SARVAM_ORG_ID?.trim();
        const workspaceId = process.env.SARVAM_WORKSPACE_ID?.trim();
        const appId = process.env.SARVAM_APP_ID?.trim();
        if (!apiKey || !orgId || !workspaceId || !appId) {
            return res.status(500).json({ message: "Sarvam configuration missing" });
        }

        // Frontend sends ?recordingUrl=...; ?url=... is also accepted
        const rawUrl = req.query.recordingUrl || req.query.url;
        let target;
        try {
            target = new URL(String(rawUrl || ""));
        } catch {
            console.error("[audio] invalid url param:", rawUrl);
            return res.status(400).json({ message: "Invalid audio url" });
        }
        if (target.protocol !== "https:" || target.hostname !== SARVAM_MEDIA_HOST) {
            return res.status(400).json({ message: "Audio host not allowed" });
        }

        const interactionId = target.searchParams.get("interaction_id");
        if (!interactionId) {
            return res.status(400).json({ message: "recordingUrl has no interaction_id" });
        }

        // The id looks like "20261001/708190c5-14:52:06-45a45272" (contains "/" and ":").
        // Try it fully encoded first, then with the slash kept as a path separator.
        const base = `https://${ANALYTICS_HOST}/api/analytics/v1/${orgId}/${workspaceId}/${appId}/recordings`;
        const candidates = [
            `${base}/${encodeURIComponent(interactionId)}`,
            `${base}/${interactionId.split("/").map(encodeURIComponent).join("/")}`,
        ];

        let upstream;
        for (const [idx, url] of candidates.entries()) {
            upstream = await fetchFollowingRedirects(url, apiKey, `recordings#${idx}`);
            if (upstream.ok) break;
            console.error(`[audio] recordings#${idx} failed: ${upstream.status}`);
        }

        if (!upstream.ok) {
            const body = summarizeBody(await upstream.text());
            console.error(`[audio] recordings API failed: ${upstream.status}`, body);
            return res.status(502).json({
                message: `Sarvam recordings API returned ${upstream.status}`,
                details: body,
            });
        }

        let buffer = Buffer.from(await upstream.arrayBuffer());
        let contentType = upstream.headers.get("content-type") || "";

        // JSON response: expect a link to the actual file
        if (contentType.includes("json") || buffer[0] === 0x7b /* "{" */ || buffer[0] === 0x22 /* '"' */) {
            let json;
            try {
                json = JSON.parse(buffer.toString("utf8"));
            } catch { /* not JSON after all; fall through to the audio check */ }

            if (json !== undefined) {
                const fileUrl = findUrlInJson(json);
                if (!fileUrl) {
                    const keys = json && typeof json === "object" ? Object.keys(json).join(", ") : typeof json;
                    console.error("[audio] JSON without a file url. keys:", keys);
                    return res.status(502).json({
                        message: "Recordings API returned JSON without an audio URL",
                        details: `keys: ${keys || "(empty)"}`,
                    });
                }
                if (!/^https:/i.test(fileUrl)) {
                    return res.status(502).json({ message: "Recording link is not https" });
                }

                const fileResp = await fetchFollowingRedirects(fileUrl, apiKey, "file");
                if (!fileResp.ok) {
                    const body = summarizeBody(await fileResp.text());
                    console.error(`[audio] file fetch failed: ${fileResp.status}`, body);
                    return res.status(502).json({
                        message: `Recording file returned ${fileResp.status}`,
                        details: body,
                    });
                }
                buffer = Buffer.from(await fileResp.arrayBuffer());
                contentType = fileResp.headers.get("content-type") || "";
            }
        }

        const type = sniffAudioType(buffer) || (contentType.startsWith("audio/") ? contentType : null);
        if (!type) {
            const preview = summarizeBody(buffer.subarray(0, 300).toString("utf8"));
            console.error("[audio] response is not audio:", contentType, preview);
            return res.status(502).json({
                message: "Sarvam did not return audio",
                details: `content-type=${contentType}; body=${preview}`,
            });
        }

        res.set({
            "Content-Type": type,
            "Content-Length": buffer.length,
            "Cache-Control": "private, max-age=3600",
        });
        return res.status(200).send(buffer);
    } catch (error) {
        console.error("Audio proxy failed:", error);
        return res.status(500).json({ message: "Audio proxy failed", details: error.message });
    }
};





// ---------------------------------------------------------------------------
// 4) Auth diagnostic (read-only): tries header/org-id combinations against the
//    Conversations gateway and reports which ones get past authentication.
//    Any status other than 401 means that combination passed auth.
// ---------------------------------------------------------------------------
export const sarvamAuthDiagnose = async (req, res) => {
    try {
        const key = process.env.SARVAM_API_KEY?.trim();
        const workspaceId = process.env.SARVAM_WORKSPACE_ID?.trim();
        if (!key || !workspaceId) {
            return res.status(500).json({ message: "SARVAM_API_KEY or SARVAM_WORKSPACE_ID not loaded" });
        }

        // Org IDs to try: the one from .env, plus the short id embedded in the key (sk_<orgId>_...)
        const keyOrgId = key.split("_")[1];
        const orgIds = [...new Set([process.env.SARVAM_ORG_ID?.trim(), keyOrgId].filter(Boolean))];

        const headerVariants = {
            "X-API-Key": { "X-API-Key": key },
            "api-subscription-key": { "api-subscription-key": key },
            "Authorization: Bearer": { Authorization: `Bearer ${key}` },
        };

        const results = [];
        for (const orgId of orgIds) {
            for (const [headerName, headers] of Object.entries(headerVariants)) {
                const url = `https://apps.sarvam.ai/api/app-authoring/v1/orgs/${orgId}/workspaces/${workspaceId}/deployments`;
                try {
                    const r = await fetch(url, { method: "GET", headers });
                    const text = await r.text();
                    results.push({
                        orgId,
                        header: headerName,
                        status: r.status,
                        passedAuth: r.status !== 401,
                        body: text.slice(0, 200),
                    });
                } catch (e) {
                    results.push({ orgId, header: headerName, error: e.message });
                }
            }
        }

        return res.status(200).json({ keyLength: key.length, results });
    } catch (error) {
        console.error("Sarvam auth diagnose failed:", error);
        return res.status(500).json({ message: "Diagnostic failed", error: error.message });
    }
};