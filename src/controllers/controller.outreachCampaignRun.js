// controllers/controller.outreachCampaignRun.js
//
// Runs a campaign NOW (the Run button) and keeps the report.
// Channels built so far: email, whatsapp_baileys.
// whatsapp_meta and ai_calling are skipped for now and listed in the run as "notRun".
//
// How it works
//  1. POST /campaigns/:id/run checks everything, creates a "run" row and answers at once (202).
//  2. Sending carries on in the background. Channels run side by side; inside a channel customers go one by one.
//  3. Every customer + channel gets one log row (sent / failed / skipped). run.summary holds the live counts.
//  4. The UI polls GET /campaigns/:id/runs/:runId for progress and, at the end, the report.
//
// Sends from the CAMPAIGN OWNER's accounts (their mailbox, their WhatsApp), so scheduled runs work the same way later.
// startCampaignRun() is exported so the scheduler can call it.
//
// CHANGES IN THIS VERSION (search for "FIX"):
//  FIX 1  trackingForRuns: sent/failed always come from run.summary; also returns `tracked` = how many
//         messages of the run have a ChannelMessage row (0 means "no tracking data", not "no replies").
//  FIX 2  healRun: old ChannelMessage rows that were saved without runId are linked to their run once, on read.
//  FIX 3  getCampaignRun: per-customer email "delivered" follows the same rule as the totals; stable log paging.

import crypto from "node:crypto";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { sendEmail } from "../config/mailer.js";
import { sendBaileysWhatsApp } from "../config/twilio.js";
import { toWaNumber } from "../utils/phone.js";
import { replacePlaceholders } from "./controller.messages.js";
import { getCustomerAccessFilter } from "./controller.customer.js";
import { templateAttachments, removeAttachments, htmlToText } from "./controller.emailCompose.js";
import { ownedWhere } from "./controller.outreachCampaign.js";
import { trackEmailInbox } from "../utils/channelTracking.js";
import { syncInbox } from "../utils/email/inboxSync.js";

/* ================= SETTINGS ================= */

const RUNNABLE = ["email", "whatsapp_baileys"]; // channels that can run today
const EMAIL_PAUSE_MS = 2000; // wait between emails: 2000 = 2 seconds (really 2-4s)
const WA_PAUSE_MIN_MS = 3000; // wait between WhatsApp messages: 3-7 seconds (ban protection)
const WA_PAUSE_MAX_MS = 7000;
const MAX_CONSECUTIVE_FAILS = 5; // stop a channel after this many failures in a row
const STALE_MS = 10 * 60_000; // a "running" run with no activity for 10 min is marked failed
const MONITOR_MS = 5 * 60_000;

/* ================= HELPERS ================= */

const fail = (err, next) => next(err instanceof ApiError ? err : new ApiError(500, err.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emailPause = () => EMAIL_PAUSE_MS + Math.random() * EMAIL_PAUSE_MS;
const waPause = () => WA_PAUSE_MIN_MS + Math.random() * (WA_PAUSE_MAX_MS - WA_PAUSE_MIN_MS);

// errors after which it makes no sense to try the next customer
const emailFatal = (err) =>
    err?.code === "EAUTH" ||
    [530, 534, 535].includes(err?.responseCode) ||
    /No email connected|decrypt|credentials|EMAIL_CONFIG_SECRET|quota|rate limit|too many|limit exceeded/i.test(err?.message || "");
const waFatal = (err) => /failed to (stabilize\/)?connect|not linked/i.test(err?.message || "");

const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/** Email bodies are HTML, so customer values must be escaped (a name like "<b>x" must not become markup). */
const escapedCustomer = (c) => {
    const cf = c.CustomerFields && typeof c.CustomerFields === "object" ? c.CustomerFields : {};
    return {
        customerName: esc(c.customerName),
        City: esc(c.City),
        Campaign: esc(c.Campaign),
        ContactNumber: esc(c.ContactNumber),
        Email: esc(c.Email),
        CustomerFields: Object.fromEntries(
            Object.entries(cf).map(([k, v]) => [k, esc(v !== null && typeof v === "object" ? JSON.stringify(v) : v)])
        ),
    };
};

/** Fill {{placeholders}}; a {{CustomerFields.X}} the customer doesn't have is blanked, never sent raw. */
const fill = (str, ctx) => replacePlaceholders(str, ctx).replace(/\{\{\s*CustomerFields\.[^}]*\}\}/g, "");

// same rule as resolveMediaType() in controller.messages.js
const resolveMediaType = (t) => {
    const hasFile = Array.isArray(t.whatsappImage) && t.whatsappImage.length > 0;
    if (["image", "video", "document"].includes(t.whatsappMediaType) && hasFile) return t.whatsappMediaType;
    if (t.whatsappPoll?.name) return "poll";
    if (t.whatsappLocation?.lat != null && t.whatsappLocation?.lng != null) return "location";
    return "text";
};

const emptyT = () => ({ sent: 0, failed: 0, tracked: 0, delivered: 0, opened: 0, replied: 0, bounced: 0 });

/**
 * FIX 1
 * runs -> Map(runId -> { email: {...}, whatsapp_baileys: {...} })
 *  - sent / failed come from run.summary (always there, even if tracking rows are missing)
 *  - delivered / opened / replied / bounced come from the ChannelMessage tracking rows
 * Before, this returned {} whenever no ChannelMessage row carried the runId, so the UI showed nothing.
 */
export const trackingForRuns = async (runs) => {
    const out = new Map();
    for (const r of runs) {
        const per = {};
        for (const [ch, v] of Object.entries(r.summary || {})) {
            if (v && typeof v === "object" && !Array.isArray(v) && "sent" in v) {
                per[ch] = { ...emptyT(), sent: v.sent || 0, failed: v.failed || 0 };
            }
        }
        out.set(r.id, per);
    }
    
    const ids = runs.map((r) => r.id);
    if (!ids.length) return out;

    // FIX: Replaced Prisma's buggy groupBy _count with an in-memory aggregation.
    // This safely counts non-null DateTime fields across all databases.
    const messages = await prisma.channelMessage.findMany({
        where: { runId: { in: ids }, status: "sent" },
        select: { runId: true, channel: true, deliveredAt: true, openedAt: true, repliedAt: true, bouncedAt: true }
    });

    for (const m of messages) {
        const t = (out.get(m.runId)[m.channel] ||= emptyT());
        t.tracked += 1;
        if (m.deliveredAt) t.delivered += 1;
        if (m.openedAt) t.opened += 1;
        if (m.repliedAt) t.replied += 1;
        if (m.bouncedAt) t.bounced += 1;
    }

    // SMTP has no delivery receipt: email delivered = sent minus bounced
    for (const per of out.values()) {
        if (per.email) per.email.delivered = Math.max(0, per.email.sent - per.email.bounced);
    }
    
    return out;
};

/**
 * FIX 2: runs sent before tracking rows carried runId/customerId have ChannelMessage rows with runId = null,
 * so their report shows no opens/replies. Link them once (per server start) by owner + channel + recipient + time window.
 * No `mode` option on purpose: MySQL string comparison is already case-insensitive.
 */
const healed = new Set();
const healRun = async (run, adminId) => {
    if (healed.has(run.id) || run.status === "running") return;
    healed.add(run.id);
    try {
        const logs = await prisma.outreachCampaignLog.findMany({ where: { runId: run.id, status: "sent" }, select: { customerId: true, channel: true } });
        if (!logs.length) return;
        const people = await prisma.customer.findMany({
            where: { id: { in: [...new Set(logs.map((l) => l.customerId))] } },
            select: { id: true, Email: true, ContactNumber: true, CountryCode: true },
        });
        const byId = new Map(people.map((c) => [c.id, c]));
        const from = new Date(run.startedAt.getTime() - 120_000);
        const to = new Date((run.finishedAt ?? new Date()).getTime() + 120_000);
        for (const l of logs) {
            const c = byId.get(l.customerId);
            if (!c) continue;
            const recipient = l.channel === "email" ? String(c.Email || "").trim() : c.ContactNumber ? toWaNumber(c.ContactNumber, c.CountryCode) : "";
            if (!recipient) continue;
            const done = await prisma.channelMessage.findFirst({ where: { runId: run.id, customerId: l.customerId, channel: l.channel }, select: { id: true } });
            if (done) continue;
            const row = await prisma.channelMessage.findFirst({
                where: { adminId, channel: l.channel, status: "sent", runId: null, recipient, sentAt: { gte: from, lte: to } },
                orderBy: { sentAt: "asc" },
                select: { id: true },
            });
            if (row) await prisma.channelMessage.update({ where: { id: row.id }, data: { runId: run.id, customerId: l.customerId, source: "campaign" } });
        }
    } catch (e) {
        console.error("heal run tracking failed:", e.message);
    }
};

const toPublic = (r, tracking = {}) => ({
    id: r.id, campaignId: r.campaignId, trigger: r.trigger, status: r.status, totalCustomers: r.totalCustomers,
    summary: r.summary, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt,
    tracking,
});

const ownedCampaign = (req) =>
    prisma.outreachCampaign.findFirst({ where: { id: req.params.id, ...ownedWhere(req.admin) } });

/* ================= THE RUN (background) ================= */

const execute = async ({ run, campaign, customers, emailTpl, waTpl, runnable, notRun, unavailable }) => {
    const runId = run.id;
    const adminId = campaign.createdById;
    const counts = Object.fromEntries(runnable.map((ch) => [ch, { sent: 0, failed: 0, skipped: 0 }]));
    const snapshot = () => ({ ...counts, notRun, unavailableCustomers: unavailable });
    const buffer = [];

    // write pending log rows + the live counts (every 10 customers, and at the end)
    const flush = async () => {
        if (!buffer.length) return;
        const rows = buffer.splice(0, buffer.length);
        await prisma.outreachCampaignLog.createMany({ data: rows });
        await prisma.outreachCampaignRun.update({ where: { id: runId }, data: { summary: snapshot() } });
    };
    const log = async (channel, customerId, status, detail = null) => {
        counts[channel][status]++;
        buffer.push({ runId, customerId, channel, status, detail: detail ? String(detail).slice(0, 500) : null });
        if (buffer.length >= 10) await flush();
    };
    const skipAll = async (channel, reason) => {
        for (const c of customers) await log(channel, c.id, "skipped", reason);
    };
    const isCancelled = async () =>
        (await prisma.outreachCampaignRun.findUnique({ where: { id: runId }, select: { status: true } }))?.status === "cancelled";

    /** One channel: customers one by one. handler(c) returns { skipped } | { detail? } or throws. */
    const runChannel = async (channel, handler, pause, isFatal) => {
        let fails = 0;
        let stop = null;
        for (let i = 0; i < customers.length; i++) {
            const c = customers[i];
            if (!stop && (await isCancelled())) stop = "The run was cancelled";
            if (stop) { await log(channel, c.id, "skipped", stop); continue; }

            try {
                const r = await handler(c);
                if (r?.skipped) { await log(channel, c.id, "skipped", r.skipped); continue; } // nothing was sent, no pause needed
                fails = 0;
                await log(channel, c.id, "sent", r?.detail);
            } catch (err) {
                const msg = String(err?.message || "Send failed").slice(0, 300);
                await log(channel, c.id, "failed", msg);
                fails++;
                if (isFatal(err)) stop = `Stopped: ${msg}`;
                else if (fails >= MAX_CONSECUTIVE_FAILS) stop = `Stopped after ${MAX_CONSECUTIVE_FAILS} failures in a row`;
            }
            if (!stop && i < customers.length - 1) await sleep(pause());
        }
    };

    const emailJob = async () => {
        let files = [];
        try {
            files = await templateAttachments(runId, emailTpl.id, 0, 0); // downloads the template's file ONCE for the whole run
        } catch (err) {
            return skipAll("email", `Could not prepare the template's file: ${err.message}`);
        }
        const seen = new Set();
        return runChannel(
            "email",
            async (c) => {
                const email = String(c.Email || "").trim().toLowerCase();
                if (!email) return { skipped: "No email address" };
                if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { skipped: "Invalid email address" };
                if (seen.has(email)) return { skipped: "Duplicate email address" };
                seen.add(email);

                // never let a disconnected mailbox silently fall back to the platform mailbox
                const cfg = await prisma.adminEmailConfig.findUnique({ where: { adminId }, select: { isActive: true, email: true } });
                if (!cfg?.isActive) throw new Error("No email connected");

                const html = fill(emailTpl.body, escapedCustomer(c));
                const messageId = `<${crypto.randomUUID()}@${(String(cfg.email).split("@")[1] || "localhost").toLowerCase()}>`;
                const info = await sendEmail(email, fill(emailTpl.subject, c) || campaign.name, html, {
                    adminId,
                    text: htmlToText(html),
                    attachments: files,
                    messageId,
                    inReplyTo: emailTpl.inReplyTo,
                    references: emailTpl.references,
                    source: "campaign",
                    runId,
                    customerId: c.id,
                });
                return info?.sentCopy === "failed" ? { detail: "Sent, but a copy could not be saved to the Sent folder" } : {};
            },
            emailPause,
            emailFatal
        );
    };

    const baileysJob = async () => {
        const imageUrl = Array.isArray(waTpl.whatsappImage) ? waTpl.whatsappImage[0] || null : null;
        const extra = {
            mediaType: resolveMediaType(waTpl),
            fileName: waTpl.whatsappFileName || undefined,
            linkPreview: waTpl.whatsappLinkPreview || undefined,
            location: waTpl.whatsappLocation || undefined,
            poll: waTpl.whatsappPoll || undefined,
        };
        const seen = new Set();
        return runChannel(
            "whatsapp_baileys",
            async (c) => {
                if (!c.ContactNumber) return { skipped: "No phone number" };
                const phone = toWaNumber(c.ContactNumber, c.CountryCode);
                if (!phone) return { skipped: "Invalid phone number" };
                if (seen.has(phone)) return { skipped: "Duplicate phone number" };
                seen.add(phone);
                await sendBaileysWhatsApp(adminId, phone, fill(waTpl.body, c), imageUrl, { ...extra, source: "campaign", runId, customerId: c.id });
                return {};
            },
            waPause,
            waFatal
        );
    };

    try {
        const jobs = [];
        if (runnable.includes("email")) jobs.push(emailJob());
        if (runnable.includes("whatsapp_baileys")) jobs.push(baileysJob());

        // wait for BOTH channels before finishing, even if one of them crashed
        const results = await Promise.allSettled(jobs);
        const crashed = results.find((r) => r.status === "rejected");
        if (crashed) throw crashed.reason;

        await flush();
        const all = Object.values(counts);
        const sent = all.reduce((n, x) => n + x.sent, 0);
        const failed = all.reduce((n, x) => n + x.failed, 0);
        const cancelled = await isCancelled();
        await prisma.outreachCampaignRun.update({
            where: { id: runId },
            data: {
                status: cancelled ? "cancelled" : sent === 0 && failed > 0 ? "failed" : "completed",
                summary: snapshot(),
                finishedAt: new Date(),
            },
        });
    } catch (err) {
        console.error(`campaign run ${runId} crashed:`, err.message);
        await flush().catch(() => { });
        await prisma.outreachCampaignRun
            .update({
                where: { id: runId },
                data: { status: "failed", error: String(err.message).slice(0, 500), summary: snapshot(), finishedAt: new Date() },
            })
            .catch(() => { });
    } finally {
        await prisma.outreachCampaign.update({ where: { id: campaign.id }, data: { lastRunAt: new Date() } }).catch(() => { });
        await removeAttachments(runId); // the template's file lives on disk only while the run is going
    }
};

/* ================= START A RUN (used by the button now, by the scheduler later) ================= */

const starting = new Set(); // campaign ids being started / running in THIS process

export const startCampaignRun = async (campaign, { trigger = "manual", scheduleId = null } = {}) => {
    if (starting.has(campaign.id)) throw new ApiError(409, "This campaign is already running.");
    const already = await prisma.outreachCampaignRun.findFirst({ where: { campaignId: campaign.id, status: "running" }, select: { id: true } });
    if (already) throw new ApiError(409, "This campaign is already running.");

    const channels = Array.isArray(campaign.channels) ? campaign.channels : [];
    const runnable = channels.filter((c) => RUNNABLE.includes(c));
    const notRun = channels.filter((c) => !RUNNABLE.includes(c));
    if (!runnable.length) {
        throw new ApiError(400, "None of this campaign's channels can run yet (WhatsApp Meta and AI calling are coming soon).");
    }

    const adminId = campaign.createdById;
    const owner = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!owner) throw new ApiError(404, "The campaign owner no longer exists.");

    // templates (they may have been deleted since the campaign was saved)
    const getTpl = async (id, type) => {
        const t = id ? await prisma.template.findUnique({ where: { id } }) : null;
        if (!t || t.type !== type) throw new ApiError(400, `This campaign's ${type} template was deleted. Edit the campaign and choose another.`);
        return t;
    };
    const emailTpl = runnable.includes("email") ? await getTpl(campaign.emailTemplateId, "email") : null;
    const waTpl = runnable.includes("whatsapp_baileys") ? await getTpl(campaign.whatsappTemplateId, "whatsapp") : null;

    if (emailTpl) {
        const cfg = await prisma.adminEmailConfig.findUnique({ where: { adminId }, select: { isActive: true } });
        if (!cfg?.isActive) throw new ApiError(400, "No connected email account for this campaign's owner. Connect one under Email first.");
    }

    // customers: re-checked against the owner's CURRENT access (leads may have been reassigned since saving)
    const ids = Array.isArray(campaign.customerIds) ? campaign.customerIds : [];
    const access = await getCustomerAccessFilter(owner);
    const rows = await prisma.customer.findMany({
        where: { AND: [access, { id: { in: ids } }] },
        select: { id: true, customerName: true, ContactNumber: true, CountryCode: true, City: true, Campaign: true, Email: true, CustomerFields: true },
    });
    if (!rows.length) throw new ApiError(400, "None of this campaign's customers are available any more.");
    const order = new Map(ids.map((id, i) => [id, i]));
    const customers = rows.sort((a, b) => order.get(a.id) - order.get(b.id));
    const unavailable = ids.length - customers.length;

    const run = await prisma.outreachCampaignRun.create({
        data: {
            campaignId: campaign.id,
            trigger,
            scheduleId,
            totalCustomers: customers.length,
            summary: { notRun, unavailableCustomers: unavailable },
        },
    });

    starting.add(campaign.id);
    execute({ run, campaign, customers, emailTpl, waTpl, runnable, notRun, unavailable })
        .catch((e) => console.error("campaign run failed to execute:", e.message))
        .finally(() => starting.delete(campaign.id));

    return {
        run,
        warning: notRun.length ? "WhatsApp Meta and AI calling are not available yet, so those channels were skipped." : undefined,
    };
};

/* ================= HANDLERS ================= */

// POST /campaigns/:id/run
export const runCampaignNow = async (req, res, next) => {
    try {
        const campaign = await ownedCampaign(req);
        if (!campaign) return next(new ApiError(404, "Campaign not found"));
        const { run, warning } = await startCampaignRun(campaign, { trigger: "manual" });
        res.status(202).json({ success: true, warning, run: toPublic(run) });
    } catch (err) {
        fail(err, next);
    }
};

// GET /campaigns/:id/runs?page=&limit=  (one row per run = the report headers)
export const getCampaignRuns = async (req, res, next) => {
    try {
        const campaign = await ownedCampaign(req);
        if (!campaign) return next(new ApiError(404, "Campaign not found"));

        // FIX: Reconcile replies currently in the DB instantly
        await trackEmailInbox(campaign.createdById).catch(() => {});
        // FIX: Non-blocking background IMAP sync to fetch new emails from Hostinger/Gmail
        syncInbox(campaign.createdById).catch(() => {});

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
        const where = { campaignId: campaign.id };
        const [total, runs] = await Promise.all([
            prisma.outreachCampaignRun.count({ where }),
            prisma.outreachCampaignRun.findMany({ where, orderBy: { startedAt: "desc" }, skip: (page - 1) * limit, take: limit }),
        ]);
        await Promise.all(runs.map((r) => healRun(r, campaign.createdById)));
        const tmap = await trackingForRuns(runs); // FIX 1: pass the runs, not just ids
        res.json({ success: true, total, currentPage: page, totalPages: Math.ceil(total / limit), data: runs.map((r) => toPublic(r, tmap.get(r.id))) });
    } catch (err) {
        fail(err, next);
    }
};

// GET /campaigns/:id/runs/:runId?channel=&status=&page=&limit=  (progress while running, full report after)
export const getCampaignRun = async (req, res, next) => {
    try {
        const campaign = await ownedCampaign(req);
        if (!campaign) return next(new ApiError(404, "Campaign not found"));
        const run = await prisma.outreachCampaignRun.findFirst({ where: { id: req.params.runId, campaignId: campaign.id } });
        if (!run) return next(new ApiError(404, "Run not found"));
        // FIX: Reconcile replies and trigger background sync here too
        await trackEmailInbox(campaign.createdById).catch(() => {});
        syncInbox(campaign.createdById).catch(() => {});
        await healRun(run, campaign.createdById);

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
        const { channel, status } = req.query;
        const where = { runId: run.id, ...(channel && { channel: String(channel) }), ...(status && { status: String(status) }) };

        const [total, logs] = await Promise.all([
            prisma.outreachCampaignLog.count({ where }),
            // FIX 3: rows written by one createMany share the same createdAt, so add id for a stable page order
            prisma.outreachCampaignLog.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit }),
        ]);

        // logs only store the customer id, so add names for display
        const customerIds = [...new Set(logs.map((l) => l.customerId))];
        const [people, msgs, tmap] = await Promise.all([
            prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, customerName: true, ContactNumber: true, Email: true } }),
            prisma.channelMessage.findMany({
                where: { runId: run.id, customerId: { in: customerIds } },
                select: { customerId: true, channel: true, sentAt: true, deliveredAt: true, openedAt: true, openCount: true, repliedAt: true, bouncedAt: true },
                orderBy: { sentAt: "desc" },
            }),
            trackingForRuns([run]),
        ]);
        const byId = new Map(people.map((p) => [p.id, p]));
        const track = new Map();
        for (const m of msgs) if (!track.has(`${m.customerId}:${m.channel}`)) track.set(`${m.customerId}:${m.channel}`, m); // newest only

        // FIX 3: SMTP has no delivery receipt, so an email counts as delivered unless it bounced (same rule as the totals)
        const trackOf = (m) =>
            m && {
                deliveredAt: m.channel === "email" ? (m.bouncedAt ? null : m.deliveredAt ?? m.sentAt) : m.deliveredAt,
                openedAt: m.openedAt,
                openCount: m.openCount,
                repliedAt: m.repliedAt,
                bouncedAt: m.bouncedAt,
            };

        res.json({
            success: true,
            run: toPublic(run, tmap.get(run.id)),
            logs: {
                total, page, limit, totalPages: Math.ceil(total / limit),
                items: logs.map((l) => {
                    const m = track.get(`${l.customerId}:${l.channel}`);
                    return {
                        id: l.id,
                        customerId: l.customerId,
                        customerName: byId.get(l.customerId)?.customerName ?? "(customer deleted)",
                        contactNumber: byId.get(l.customerId)?.ContactNumber ?? null,
                        email: byId.get(l.customerId)?.Email ?? null,
                        channel: l.channel,
                        status: l.status,
                        detail: l.detail,
                        createdAt: l.createdAt,
                        tracking: trackOf(m) ?? null,
                    };
                }),
            },
        });
    } catch (err) {
        fail(err, next);
    }
};

// POST /campaigns/:id/runs/:runId/cancel  (the run stops before its next customer; what was sent stays sent)
export const cancelCampaignRun = async (req, res, next) => {
    try {
        const campaign = await ownedCampaign(req);
        if (!campaign) return next(new ApiError(404, "Campaign not found"));
        await prisma.outreachCampaignRun.updateMany({
            where: { id: req.params.runId, campaignId: campaign.id, status: "running" },
            data: { status: "cancelled" },
        });
        const run = await prisma.outreachCampaignRun.findFirst({ where: { id: req.params.runId, campaignId: campaign.id } });
        if (!run) return next(new ApiError(404, "Run not found"));
        res.json({ success: true, run: toPublic(run) });
    } catch (err) {
        fail(err, next);
    }
};

/* ================= SAFETY NET ================= */

/**
 * Call once at server start. If the server dies mid-run, that run would stay "running" forever and
 * block editing / deleting / re-running the campaign. This marks runs with no activity for 10 minutes
 * as failed. It is safe with several server instances: a live run keeps writing logs, so it is never touched.
 */
export const startCampaignRunMonitor = () => {
    const sweep = async () => {
        try {
            const cutoff = new Date(Date.now() - STALE_MS);
            const stale = await prisma.outreachCampaignRun.findMany({
                where: { status: "running", startedAt: { lt: cutoff }, logs: { none: { createdAt: { gte: cutoff } } } },
                select: { id: true },
            });
            for (const r of stale) {
                await prisma.outreachCampaignRun.updateMany({
                    where: { id: r.id, status: "running" },
                    data: { status: "failed", error: "Interrupted (server restart or crash). Run the campaign again.", finishedAt: new Date() },
                });
                await removeAttachments(r.id);
            }
        } catch (e) {
            console.error("campaign run monitor failed:", e.message);
        }
        setTimeout(sweep, MONITOR_MS).unref();
    };
    setTimeout(sweep, 30_000).unref();
};