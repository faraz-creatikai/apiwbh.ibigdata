// controllers/controller.emailCompose.js
//
// Send email FROM the inbox: bulk compose + reply (+ progress + cancel + background sender).
//
//  - Recipients come from the admin's OWN inbox (messageIds -> their senders), plus optional typed
//    addresses. There is NO CRM-lead restriction here: the inbox belongs to the logged-in admin.
//  - Always sends through the admin's connected mailbox. Never falls back to the platform mailbox.
//  - Every request becomes one EmailSendBatch row and goes through ONE pipeline:
//      request -> batch row -> worker sends one by one (throttled) -> request waits up to 8s
//      -> returns final result, or "still running" + batchId for the frontend to poll.
//  - Each recipient gets their own email (nobody sees other recipients), placeholders filled per person.
//  - A lead match (same email, only leads this admin may see) is used ONLY to fill {{placeholders}}.
//  - Never sends the same email twice: a crash mid-send marks that one recipient failed instead of retrying.
//
//  npm i sanitize-html   (already installed for the inbox sync)

import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { sendEmail } from "../config/mailer.js";
import { replacePlaceholders } from "./controller.messages.js";
import { getCustomerAccessFilter } from "./controller.customer.js";

import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertPublicHost } from "../utils/email/emailProviders.js";

/* ================= SETTINGS — the only numbers you might want to change ================= */

const MAX_RECIPIENTS = 500; // most people a single send can go to
const MAX_EMAILS_PER_DAY = 300; // most emails ONE mailbox may send from the inbox in 24 hours (keeps you under your email provider's limit)
const PAUSE_BETWEEN_EMAILS_MS = 2000; // wait between emails in a bulk send: 2000 = 2 seconds (it really waits 2–4s). Don't go much lower or providers may block you
const MAX_FILES = 5; // attachments per send
const MAX_ATTACH_MB = 20; // total size of all attachments in one send

/* ================= INTERNAL — leave these as they are ================= */

const MAX_ATTACH_BYTES = MAX_ATTACH_MB * 1024 * 1024;
const WAIT_MS = 8000; // how long a request waits for the send to finish before replying "still running" (the frontend then checks progress)
const LOCK_MS = 5 * 60_000; // "this send is being handled" marker; if the server dies, another run takes over after 5 min
const SEND_TIMEOUT_MS = 150_000; // give up on one email after 2.5 min
const MAX_CONSECUTIVE_FAILS = 5; // stop a bulk send after this many failures in a row
const TICK_MS = 15_000; // how often the background worker looks for unfinished sends
const ATTACH_ROOT = path.join(process.cwd(), "uploads", "email-batches"); // attachments wait here until the send ends

// addresses that never read mail (your own sync already stored several of these)
const NO_REPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?)(?:[+._-][^@]*)?@/i;

/* ------------------------------ small helpers ------------------------------ */

class Reject extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}
const fail = (err, res, next) =>
    err instanceof Reject
        ? res.status(err.status).json({ success: false, message: err.message, ...err.extra })
        : next(new ApiError(500, err.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delayMs = () => PAUSE_BETWEEN_EMAILS_MS + Math.random() * PAUSE_BETWEEN_EMAILS_MS;

const withTimeout = (p, ms) =>
    new Promise((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error("Timed out waiting for the mail server — the email may still have been sent, check your Sent folder.")),
            ms
        );
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });

const escHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Placeholder values go into HTML, so they must be escaped (a name like "<b>x" must not become markup). */
const escCtx = (ctx) => {
    const { CustomerFields, ...rest } = ctx || {};
    const cf = CustomerFields && typeof CustomerFields === "object" ? CustomerFields : {};
    return {
        ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, escHtml(v)])),
        CustomerFields: Object.fromEntries(
            Object.entries(cf).map(([k, v]) => [k, escHtml(v !== null && typeof v === "object" ? JSON.stringify(v) : v)])
        ),
    };
};

/** replacePlaceholders leaves {{CustomerFields.X}} untouched when the recipient has no such field — blank it, never send it raw. */
const fill = (str, ctx) => replacePlaceholders(str, ctx).replace(/\{\{\s*CustomerFields\.[^}]*\}\}/g, "");

const htmlToText = (html) =>
    sanitizeHtml(String(html || "").replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, "\n"), {
        allowedTags: [],
        allowedAttributes: {},
    })
        .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

/** multipart sends arrays as JSON strings / repeated fields; JSON bodies send real arrays. */
const asList = (v) => {
    if (v == null || v === "") return [];
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
        try {
            const p = JSON.parse(v);
            return Array.isArray(p) ? p : [p];
        } catch {
            return [v];
        }
    }
    return [v];
};

const uploadedFiles = (req) => (Array.isArray(req.files) ? req.files : req.files?.attachments || []);
const cleanupFiles = (files) => files.forEach((f) => { try { fs.unlinkSync(f.path); } catch { /* already moved/removed */ } });
const cleanName = (n) => path.basename(String(n || "")).replace(/[\r\n"]/g, "").slice(0, 200);

const checkFiles = (files) => {
    if (files.length > MAX_FILES) throw new Reject(400, `You can attach at most ${MAX_FILES} files.`);
    const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
    if (bytes > MAX_ATTACH_BYTES) throw new Reject(413, `Attachments are too large (max ${MAX_ATTACH_BYTES / 1024 / 1024} MB in total).`);
};

const moveAttachments = async (batchId, files) => {
    if (!files.length) return [];
    const dir = path.join(ATTACH_ROOT, batchId);
    await fs.promises.mkdir(dir, { recursive: true });
    const out = [];
    for (const [i, f] of files.entries()) {
        const dest = path.join(dir, `${i}-${crypto.randomBytes(4).toString("hex")}`);
        try {
            await fs.promises.rename(f.path, dest);
        } catch {
            await fs.promises.copyFile(f.path, dest); // different disk
            await fs.promises.unlink(f.path).catch(() => { });
        }
        out.push({ filename: cleanName(f.originalname) || `attachment-${i + 1}`, path: dest, contentType: f.mimetype });
    }
    return out;
};
const removeAttachments = (batchId) => fs.promises.rm(path.join(ATTACH_ROOT, batchId), { recursive: true, force: true }).catch(() => { });

/* ------------------------------ template media ------------------------------ */

// Template files live on Cloudinary. Only these hosts may be downloaded (env override, comma separated).
const MEDIA_HOSTS = (process.env.EMAIL_MEDIA_HOSTS || "res.cloudinary.com")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const MEDIA_TIMEOUT_MS = 60_000;
const MIME_BY_EXT = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv", zip: "application/zip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const urlList = (v) => {
    let x = v;
    if (typeof x === "string") { try { x = JSON.parse(x); } catch { return []; } }
    return Array.isArray(x) ? x.filter((u) => typeof u === "string" && u) : [];
};

/** Downloads ONE file: https only, allow-listed host, public IPs only, hard size cap, no redirects. */
const downloadMedia = async (rawUrl, dest, maxBytes) => {
    let u;
    try { u = new URL(rawUrl); } catch { throw new Reject(400, "The template's file link is invalid."); }
    if (u.protocol !== "https:" || !MEDIA_HOSTS.includes(u.hostname.toLowerCase())) {
        throw new Reject(400, "The template's file is not hosted on an allowed domain.");
    }
    try { await assertPublicHost(u.hostname); }
    catch { throw new Reject(400, "The template's file host is not reachable."); }

    const tooBig = () => new Reject(413, `Attachments are too large (max ${MAX_ATTACH_MB} MB in total, including the template's file).`);
    let res;
    try { res = await fetch(u, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS), redirect: "error" }); }
    catch { throw new Reject(502, "Could not download the template's file. Try again in a moment."); }
    if (!res.ok || !res.body) throw new Reject(502, `Could not download the template's file (HTTP ${res.status}).`);
    if (Number(res.headers.get("content-length")) > maxBytes) throw tooBig();

    let size = 0;
    const cap = new Transform({
        transform(chunk, _enc, cb) {
            size += chunk.length;
            size > maxBytes ? cb(tooBig()) : cb(null, chunk);
        },
    });
    await pipeline(Readable.fromWeb(res.body), cap, fs.createWriteStream(dest));
    return { size, contentType: (res.headers.get("content-type") || "").split(";")[0] };
};

/** Template -> attachment entries (files already saved in the batch folder). [] when the template has no media. */
const templateAttachments = async (batchId, templateId, usedFiles, usedBytes) => {
    const tpl = await prisma.template.findUnique({ where: { id: templateId } });
    if (!tpl || tpl.type !== "email") throw new Reject(404, "Template not found");

    const urls = urlList(tpl.whatsappImage);
    if (!urls.length || !["image", "video", "document"].includes(tpl.whatsappMediaType)) return []; // same rule as resolveMediaType()
    if (usedFiles + urls.length > MAX_FILES) {
        throw new Reject(400, `Too many attachments: the template's file counts towards the limit of ${MAX_FILES}.`);
    }

    const dir = path.join(ATTACH_ROOT, batchId);
    await fs.promises.mkdir(dir, { recursive: true });

    const out = [];
    let bytes = usedBytes;
    for (const [i, url] of urls.entries()) {
        const dest = path.join(dir, `tpl${i}-${crypto.randomBytes(4).toString("hex")}`);
        const got = await downloadMedia(url, dest, MAX_ATTACH_BYTES - bytes);
        bytes += got.size;

        let fromUrl = "";
        try { fromUrl = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch { /* keep "" */ }
        const preferred = tpl.whatsappMediaType === "document" && urls.length === 1 && tpl.whatsappFileName ? tpl.whatsappFileName : fromUrl;
        let filename = cleanName(preferred) || `template-file-${i + 1}`;
        if (!path.extname(filename) && path.extname(fromUrl)) filename += path.extname(fromUrl); // "Brochure" -> "Brochure.pdf"

        const ext = path.extname(filename).slice(1).toLowerCase();
        out.push({ filename, path: dest, contentType: MIME_BY_EXT[ext] || got.contentType || "application/octet-stream" });
    }
    return out;
};


const tally = (rs) => ({
    sent: rs.filter((r) => r.status === "sent").length,
    failed: rs.filter((r) => r.status === "failed").length,
    skipped: rs.filter((r) => r.status === "skipped").length,
});

const FINISHED = ["done", "failed", "cancelled"];

const toPublic = (b) => ({
    id: b.id,
    kind: b.kind,
    status: b.status,
    subject: b.subject,
    total: b.total,
    sent: b.sent,
    failed: b.failed,
    skipped: b.skipped,
    pending: Math.max(0, b.total - b.sent - b.failed - b.skipped),
    error: b.error,
    createdAt: b.createdAt,
    finishedAt: b.finishedAt,
    recipients: publicRecipients(b.recipients || []),
});
const publicRecipients = (rs) =>
    rs.map(({ email, name, status, reason, error, lead }) => ({ email, name, status, reason, error, lead: !!lead }));

/* ------------------------------ recipients ------------------------------ */

/**
 * picked: [{ email, name }] in priority order. Returns one entry per address.
 * Skips (and reports): duplicates, invalid, your own address, no-reply/bounce addresses.
 */
const buildRecipients = async (admin, ownEmail, picked, extraSkipped = []) => {
    const own = String(ownEmail).toLowerCase();
    const seen = new Set();
    const entries = [];

    for (const p of picked) {
        const email = String(p.email || "").trim().toLowerCase();
        let reason = null;
        if (seen.has(email)) reason = "duplicate";
        else if (!/^[^@\s]+@[^@\s]+$/.test(email)) reason = "invalid_address";
        else if (email === own) reason = "own_address";
        else if (NO_REPLY.test(email)) reason = "no_reply_address";
        seen.add(email);
        entries.push({ email, name: p.name || "", status: reason ? "skipped" : "queued", ...(reason && { reason }) });
    }
    entries.push(...extraSkipped);

    // Lead match: only to fill {{placeholders}}. Uses the admin's own access filter, never blocks anyone.
    const queued = entries.filter((e) => e.status === "queued");
    const leads = new Map();
    if (queued.length) {
        const access = await getCustomerAccessFilter(admin);
        const rows = await prisma.customer.findMany({
            where: { AND: [access, { Email: { in: queued.map((e) => e.email) } }] },
            select: { customerName: true, City: true, Campaign: true, ContactNumber: true, Email: true, CustomerFields: true },
        });
        for (const l of rows) {
            const k = String(l.Email || "").toLowerCase();
            if (k && !leads.has(k)) leads.set(k, l);
        }
    }
    for (const e of queued) {
        const l = leads.get(e.email);
        e.lead = !!l;
        e.ctx = l
            ? {
                customerName: l.customerName || e.name,
                City: l.City || "",
                Campaign: l.Campaign || "",
                ContactNumber: l.ContactNumber || "",
                Email: l.Email || e.email,
                CustomerFields: l.CustomerFields || {},
            }
            : { customerName: e.name, City: "", Campaign: "", ContactNumber: "", Email: e.email, CustomerFields: {} };
    }
    return entries;
};

/* ------------------------------ batch creation (shared by compose + reply) ------------------------------ */

const remainingToday = async (adminId) => {
    const rows = await prisma.emailSendBatch.findMany({
        where: { adminId, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
        select: { status: true, total: true, sent: true, skipped: true },
    });
    const used = rows.reduce(
        (n, b) => n + (["queued", "sending"].includes(b.status) ? b.total - b.skipped : b.sent),
        0
    );
    return Math.max(0, MAX_EMAILS_PER_DAY - used);
};

const enqueue = async ({ admin, kind, subject, body, quoteHtml = null, picked, extraSkipped = [], files, templateId = null, inReplyTo = null, refs = null }) => {
    if (!htmlToText(body)) throw new Reject(400, "Message body is required");

    const cfg = await prisma.adminEmailConfig.findUnique({
        where: { adminId: admin.id },
        select: { email: true, isActive: true },
    });
    if (!cfg?.isActive) {
        throw new Reject(400, "Connect your email account first — inbox emails are always sent from your connected mailbox.");
    }

    const recipients = await buildRecipients(admin, cfg.email, picked, extraSkipped);
    const queued = recipients.filter((r) => r.status === "queued").length;
    if (!queued) {
        throw new Reject(422, "None of the selected recipients can be emailed.", { recipients: publicRecipients(recipients) });
    }

    if (kind === "compose") {
        const active = await prisma.emailSendBatch.findFirst({
            where: { adminId: admin.id, kind: "compose", status: { in: ["queued", "sending"] } },
            select: { id: true },
        });
        if (active) throw new Reject(409, "Another bulk send is still running. Wait for it to finish or cancel it.", { activeBatchId: active.id });

        const left = await remainingToday(admin.id);
        if (queued > left) {
            throw new Reject(
                429,
                `Daily sending limit: ${left} of ${MAX_EMAILS_PER_DAY} emails left in the last 24 hours, but this send has ${queued} recipients.`,
                { remaining: left, limit: MAX_EMAILS_PER_DAY }
            );
        }
    }

    const id = crypto.randomUUID();
    try {
        const attachments = await moveAttachments(id, files);
        if (templateId) {
            const usedBytes = files.reduce((n, f) => n + (f.size || 0), 0);
            attachments.push(...(await templateAttachments(id, templateId, files.length, usedBytes)));
        }
        await prisma.emailSendBatch.create({
            data: {
                id,
                adminId: admin.id,
                kind,
                status: "queued",
                subject,
                bodyHtml: body,
                quoteHtml,
                attachments,
                inReplyTo,
                refs,
                recipients,
                total: recipients.length,
                skipped: recipients.length - queued,
            },
        });
    } catch (e) {
        await removeAttachments(id);
        throw e;
    }

    // run it now; wait a little so small sends (a reply, a handful of emails) answer with the final result
    const job = processEmailSendBatch(id);
    await Promise.race([job, new Promise((r) => setTimeout(r, WAIT_MS).unref?.())]);

    const fresh = await prisma.emailSendBatch.findUnique({ where: { id } });
    return { success: true, done: FINISHED.includes(fresh.status), batch: toPublic(fresh) };
};

/* ------------------------------ the sender ------------------------------ */

const isFatal = (err) =>
    err?.code === "EAUTH" ||
    [530, 534, 535].includes(err?.responseCode) ||
    /No email connected|decrypt|credentials|EMAIL_CONFIG_SECRET|quota|rate limit|too many|limit exceeded/i.test(err?.message || "");

/** Marks what is left, writes the final state, deletes the attachment files. */
const settle = async (id, recipients, stop) => {
    const reason = stop?.reason || "batch_stopped";
    for (const r of recipients) {
        if (r.status === "sending") {
            r.status = "failed";
            r.error = "Interrupted by a server restart — not retried to avoid sending twice. Check your Sent folder.";
        } else if (r.status === "queued") {
            r.status = "skipped";
            r.reason = reason;
        }
    }
    const t = tally(recipients);
    const status = stop?.status || (t.sent === 0 && t.failed > 0 ? "failed" : "done");
    await prisma.emailSendBatch.update({
        where: { id },
        data: { recipients, ...t, status, error: stop?.error || null, lockUntil: null, finishedAt: new Date() },
    });
    await removeAttachments(id);
};

const run = async (id) => {
    const now = new Date();
    const claim = await prisma.emailSendBatch.updateMany({
        where: { id, status: { in: ["queued", "sending"] }, OR: [{ lockUntil: null }, { lockUntil: { lt: now } }] },
        data: { status: "sending", lockUntil: new Date(now.getTime() + LOCK_MS) },
    });
    if (claim.count !== 1) return; // someone else is on it, or it's already finished

    const b = await prisma.emailSendBatch.findUnique({ where: { id } });
    const recipients = b.recipients;
    for (const r of recipients) {
        if (r.status === "sending") {
            r.status = "failed";
            r.error = "Interrupted by a server restart — not retried to avoid sending twice. Check your Sent folder.";
        }
    }

    const save = () =>
        prisma.emailSendBatch.update({
            where: { id },
            data: { recipients, ...tally(recipients), lockUntil: new Date(Date.now() + LOCK_MS) }, // also extends the lease
        });

    let stop = null;
    let consecutive = 0;
    let attempted = false;

    for (const r of recipients) {
        if (r.status !== "queued") continue;

        if (attempted) await sleep(delayMs());
        attempted = true;

        const cur = await prisma.emailSendBatch.findUnique({ where: { id }, select: { status: true } });
        if (cur?.status === "cancelled") { stop = { status: "cancelled", reason: "cancelled" }; break; }

        // never let a disconnected mailbox silently fall back to the platform mailbox
        const cfg = await prisma.adminEmailConfig.findUnique({ where: { adminId: b.adminId }, select: { isActive: true, email: true } });
        if (!cfg?.isActive) {
            stop = { status: "failed", reason: "batch_stopped", error: "Your email was disconnected, so the remaining emails were not sent." };
            break;
        }

        r.status = "sending";
        await save();

        try {
            const html = fill(b.bodyHtml, escCtx(r.ctx)) + (b.quoteHtml || "");
            const subject = fill(b.subject, r.ctx);
            const info = await withTimeout(
                sendEmail(r.email, subject, html, {
                    adminId: b.adminId,
                    text: htmlToText(html),
                    attachments: b.attachments,
                    inReplyTo: b.inReplyTo || undefined,
                    references: b.refs || undefined,
                    messageId: `<${crypto.randomUUID()}@${(String(cfg.email).split("@")[1] || "localhost").toLowerCase()}>`,
                }),
                SEND_TIMEOUT_MS
            );
            r.status = "sent";
            r.sentAt = new Date().toISOString();
            r.messageId = info?.messageId || null;
            if (info?.sentCopy === "failed") r.sentCopyError = info.sentCopyError || "Could not save a copy to the Sent folder";
            consecutive = 0;
        } catch (err) {
            r.status = "failed";
            r.error = String(err?.message || "Send failed").slice(0, 300);
            consecutive++;
            if (isFatal(err)) {
                stop = { status: "failed", reason: "batch_stopped", error: `Stopped: ${r.error}` };
            } else if (consecutive >= MAX_CONSECUTIVE_FAILS) {
                stop = { status: "failed", reason: "batch_stopped", error: `Stopped after ${MAX_CONSECUTIVE_FAILS} failures in a row: ${r.error}` };
            }
        }
        await save();
        if (stop) break;
    }

    await settle(id, recipients, stop);
};

const running = new Map(); // batchId -> promise (stops the request and the timer from running the same batch twice)

/** Never throws. Resolves when the batch has finished (or immediately if someone else owns it). */
export const processEmailSendBatch = (id) => {
    if (running.has(id)) return running.get(id);
    const p = run(id)
        .catch((err) => console.error(`email batch ${id} crashed:`, err.message))
        .finally(() => running.delete(id));
    running.set(id, p);
    return p;
};

/** Call once at server start. Resumes sends that were interrupted by a restart. */
export const startEmailSendWorker = () => {
    const tick = async () => {
        try {
            const due = await prisma.emailSendBatch.findMany({
                where: { status: { in: ["queued", "sending"] }, OR: [{ lockUntil: null }, { lockUntil: { lt: new Date() } }] },
                select: { id: true },
                take: 20,
            });
            due.forEach((b) => processEmailSendBatch(b.id));
        } catch (e) {
            console.error("email send worker tick failed:", e.message);
        }
        setTimeout(tick, TICK_MS).unref();
    };
    setTimeout(tick, 20_000).unref();
};

/* ------------------------------ POST /email/inbox/send  (bulk compose) ------------------------------ */

const composeSchema = z
    .object({
        subject: z.string().trim().min(1, "Subject is required").max(300),
        body: z.string().min(1, "Message body is required").max(500_000),
        messageIds: z.preprocess(asList, z.array(z.string().uuid("Invalid message")).max(MAX_RECIPIENTS)),
        emails: z.preprocess(asList, z.array(z.string().trim().email("Enter valid email addresses").max(254)).max(MAX_RECIPIENTS)),
        templateId: z.preprocess((v) => (v === "" ? undefined : v), z.string().uuid("Invalid template").optional()),
    })
    .refine((v) => v.messageIds.length + v.emails.length > 0, { message: "Choose at least one recipient" })
    .refine((v) => v.messageIds.length + v.emails.length <= MAX_RECIPIENTS, { message: `At most ${MAX_RECIPIENTS} recipients per send` });

// multipart (with files in "attachments") or plain JSON:
//   { subject, body (HTML), messageIds: [inbox message ids], emails?: [typed addresses] }
export const sendEmailFromInbox = async (req, res, next) => {
    const files = uploadedFiles(req);
    try {
        checkFiles(files);
        const parsed = composeSchema.safeParse(req.body || {});
        if (!parsed.success) throw new Reject(400, parsed.error.issues.map((i) => i.message).join(", "));
       const { subject, body, messageIds, emails, templateId } = parsed.data;

        // addresses come from the admin's OWN inbox rows — a client can't make us email an address it invented
        const rows = messageIds.length
            ? await prisma.emailMessage.findMany({
                where: { id: { in: messageIds }, adminId: req.admin.id },
                select: { id: true, fromEmail: true, fromName: true },
            })
            : [];
        const found = new Set(rows.map((r) => r.id));
        const extraSkipped = messageIds
            .filter((id) => !found.has(id))
            .map(() => ({ email: "(unknown message)", name: "", status: "skipped", reason: "message_not_found" }));

        const picked = [
            ...rows.map((r) => ({ email: r.fromEmail, name: r.fromName || "" })),
            ...emails.map((e) => ({ email: e, name: "" })),
        ];

         res.json(await enqueue({ admin: req.admin, kind: "compose", subject, body, picked, extraSkipped, files, templateId }));
    } catch (err) {
        fail(err, res, next);
    } finally {
        cleanupFiles(files); // no-op once moved into the batch folder
    }
};

/* ------------------------------ POST /email/inbox/reply ------------------------------ */

const replySchema = z.object({
    messageId: z.string().uuid("Invalid message"),
    body: z.string().min(1, "Message body is required").max(500_000),
    subject: z.string().trim().max(300).optional(),
    includeQuote: z.preprocess((v) => !(v === false || v === "false"), z.boolean()),
    templateId: z.preprocess((v) => (v === "" ? undefined : v), z.string().uuid("Invalid template").optional()),
});

const reSubject = (s) => (/^\s*(re|aw|sv)\s*:/i.test(s || "") ? s : `Re: ${s || ""}`.trim());

const buildQuote = (m) => {
    const who = m.fromName ? `${escHtml(m.fromName)} &lt;${escHtml(m.fromEmail)}&gt;` : escHtml(m.fromEmail);
    const text = escHtml((m.bodyText || "").slice(0, 8000)).replace(/\r?\n/g, "<br>");
    return (
        `<br><br><div>On ${escHtml(new Date(m.date).toUTCString())}, ${who} wrote:</div>` +
        `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${text}</blockquote>`
    );
};

// multipart or JSON: { messageId (inbox message id), body (HTML), subject?, includeQuote? (default true) }
export const replyToInboxEmail = async (req, res, next) => {
    const files = uploadedFiles(req);
    try {
        checkFiles(files);
        const parsed = replySchema.safeParse(req.body || {});
        if (!parsed.success) throw new Reject(400, parsed.error.issues.map((i) => i.message).join(", "));
        const { messageId, body, subject, includeQuote, templateId } = parsed.data;

        const msg = await prisma.emailMessage.findFirst({ where: { id: messageId, adminId: req.admin.id } });
        if (!msg) throw new Reject(404, "Message not found");
        if (NO_REPLY.test(msg.fromEmail)) throw new Reject(400, "This sender uses a no-reply address, so a reply would not be delivered.");

        // threading: the server builds these from the stored message, the client never sends them
        const refs = [...new Set([...(msg.refs ? msg.refs.split(/\s+/) : []), msg.messageId].filter(Boolean))].slice(-20);

        res.json(
            await enqueue({
                admin: req.admin,
                kind: "reply",
                subject: subject || reSubject(msg.subject),
                body,
                quoteHtml: includeQuote ? buildQuote(msg) : null,
                picked: [{ email: msg.fromEmail, name: msg.fromName || "" }],
                files,
                templateId,
                inReplyTo: msg.messageId || null,
                refs: refs.length ? refs.join(" ") : null,
            })
        );
    } catch (err) {
        fail(err, res, next);
    } finally {
        cleanupFiles(files);
    }
};

/* ------------------------------ GET /email/inbox/batches/:id  ·  POST .../cancel ------------------------------ */

export const getEmailSendBatch = async (req, res, next) => {
    try {
        const b = await prisma.emailSendBatch.findFirst({ where: { id: req.params.id, adminId: req.admin.id } });
        if (!b) return next(new ApiError(404, "Send not found"));
        res.json({ success: true, done: FINISHED.includes(b.status), batch: toPublic(b) });
    } catch (err) {
        next(new ApiError(500, err.message));
    }
};

export const cancelEmailSendBatch = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const id = req.params.id;
        const b = await prisma.emailSendBatch.findFirst({ where: { id, adminId } });
        if (!b) return next(new ApiError(404, "Send not found"));

        await prisma.emailSendBatch.updateMany({ where: { id, adminId, status: { in: ["queued", "sending"] } }, data: { status: "cancelled" } });

        // a live worker notices before its next email and wraps up itself; if nobody holds it, wrap up here
        const cur = await prisma.emailSendBatch.findUnique({ where: { id } });
        const held = running.has(id) || (cur.lockUntil && cur.lockUntil > new Date());
        if (cur.status === "cancelled" && !cur.finishedAt && !held) {
            await settle(id, cur.recipients, { status: "cancelled", reason: "cancelled" });
        }
        const fresh = await prisma.emailSendBatch.findUnique({ where: { id } });
        res.json({ success: true, done: FINISHED.includes(fresh.status), batch: toPublic(fresh) });
    } catch (err) {
        next(new ApiError(500, err.message));
    }
};