// controllers/controller.emailInbox.js
import { z } from "zod";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { syncInbox, pushFlags, fetchAttachment } from "../utils/email/inboxSync.js";
import { getCustomerAccessFilter } from "./controller.customer.js";

const FOLDER = "INBOX";

// list rows never carry bodies
const LIST_SELECT = {
  id: true, threadKey: true, fromEmail: true, fromName: true, subject: true,
  snippet: true, date: true, isRead: true, isStarred: true, hasAttachments: true,
};

/**
 * Tag each message with the CRM lead it came from (if any).
 * Done at read time with the admin's own customer-access filter, so an admin never learns
 * about leads they aren't allowed to see, and nothing goes stale when a lead's email changes.
 * (No `mode` option: it is PostgreSQL-only. MySQL string comparison is case-insensitive by default.)
 */
const attachCustomers = async (admin, rows) => {
  const emails = [...new Set(rows.map((r) => r.fromEmail).filter((e) => e && e !== "unknown"))];
  if (!emails.length) return rows.map((r) => ({ ...r, customer: null }));

  const access = await getCustomerAccessFilter(admin);
  const customers = await prisma.customer.findMany({
    where: { AND: [access, { OR: emails.map((e) => ({ Email: { equals: e } })) }] },
    select: { id: true, customerName: true, Email: true },
  });
  const byEmail = new Map(customers.map((c) => [c.Email.toLowerCase(), { id: c.id, name: c.customerName }]));
  return rows.map((r) => ({ ...r, customer: byEmail.get(r.fromEmail) || null }));
};

// GET /inbox/status
export const getEmailInboxStatus = async (req, res, next) => {
  try {
    const adminId = req.admin.id;
    const [cfg, state, unread] = await Promise.all([
      prisma.adminEmailConfig.findUnique({ where: { adminId }, select: { isActive: true, imapHost: true, email: true } }),
      prisma.emailInboxSyncState.findUnique({ where: { adminId } }),
      prisma.emailMessage.count({ where: { adminId, folder: FOLDER, isRead: false } }),
    ]);
    res.json({
      success: true,
      connected: !!cfg?.isActive,
      // false => mailbox was connected before inbox support existed: user must reconnect once
      available: !!cfg?.isActive && !!cfg.imapHost,
      email: cfg?.email ?? null,
      unread,
      lastSyncAt: state?.lastSyncAt ?? null,
      lastError: state?.lastError ?? null,
    });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

// POST /inbox/sync — "refresh" button. Waits up to 20s, then lets the sync finish in the background.
export const syncEmailInbox = async (req, res, next) => {
  try {
    const adminId = req.admin.id;
    const state = await prisma.emailInboxSyncState.findUnique({ where: { adminId } });
    if (state?.lastSyncAt && Date.now() - state.lastSyncAt.getTime() < 10_000) {
      return res.json({ success: true, throttled: true });
    }
    const job = syncInbox(adminId);
    job.catch(() => {});
    const r = await Promise.race([job, new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 20_000))]);
    res.json({ success: !r.error, ...r });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  unread: z.enum(["true", "false"]).optional(),
  starred: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(100).optional(),
});

// GET /inbox/messages?page=&limit=&unread=true&starred=true&q=
export const listEmailMessages = async (req, res, next) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    const { page, limit, unread, starred, q } = parsed.data;

    const where = { adminId: req.admin.id, folder: FOLDER };
    if (unread === "true") where.isRead = false;
    if (starred === "true") where.isStarred = true;
    if (q) {
      where.OR = ["subject", "fromEmail", "fromName", "snippet"].map((f) => ({ [f]: { contains: q } }));
    }

    const [total, rows] = await Promise.all([
      prisma.emailMessage.count({ where }),
      prisma.emailMessage.findMany({
        where, select: LIST_SELECT, orderBy: { date: "desc" }, skip: (page - 1) * limit, take: limit,
      }),
    ]);

    res.json({
      success: true,
      page, limit, total, totalPages: Math.ceil(total / limit),
      messages: await attachCustomers(req.admin, rows),
    });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

// GET /inbox/messages/:id — full message + the rest of its thread (no bodies)
export const getEmailMessage = async (req, res, next) => {
  try {
    const adminId = req.admin.id;
    const msg = await prisma.emailMessage.findFirst({ where: { id: req.params.id, adminId } });
    if (!msg) return next(new ApiError(404, "Message not found"));

    const { uid, ...message } = msg; // uid is an IMAP detail, no need to expose it
    const thread = await prisma.emailMessage.findMany({
      where: { adminId, threadKey: msg.threadKey, id: { not: msg.id } },
      select: LIST_SELECT,
      orderBy: { date: "asc" },
    });
    const [withCustomer] = await attachCustomers(req.admin, [message]);
    res.json({ success: true, message: withCustomer, thread });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

const patchSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    isRead: z.boolean().optional(),
    isStarred: z.boolean().optional(),
  })
  .refine((v) => v.isRead !== undefined || v.isStarred !== undefined, { message: "Nothing to update" });

// PATCH /inbox/messages  { ids, isRead?, isStarred? } — single or bulk
export const updateEmailMessages = async (req, res, next) => {
  try {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    const { ids, ...flags } = parsed.data;
    const adminId = req.admin.id;

    const rows = await prisma.emailMessage.findMany({ where: { id: { in: ids }, adminId }, select: { id: true, uid: true } });
    if (!rows.length) return next(new ApiError(404, "Messages not found"));

    await prisma.emailMessage.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: flags });
    // mirror to the real mailbox so Gmail/Zoho/etc. show the same state (best effort)
    pushFlags(adminId, rows.map((r) => r.uid), flags).catch((e) => console.error("inbox pushFlags:", e.message));

    res.json({ success: true, updated: rows.length });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

// GET /inbox/messages/:id/attachments/:index
export const downloadEmailAttachment = async (req, res, next) => {
  try {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) return next(new ApiError(400, "Invalid attachment"));

    const msg = await prisma.emailMessage.findFirst({
      where: { id: req.params.id, adminId: req.admin.id },
      select: { uid: true },
    });
    if (!msg) return next(new ApiError(404, "Message not found"));

    const att = await fetchAttachment(req.admin.id, msg.uid, index);
    if (!att) return next(new ApiError(404, "Attachment not found"));

    // never let an attacker-supplied html/svg render on our API origin
    const type = /^(text\/html|image\/svg|application\/xhtml)/i.test(att.contentType) ? "application/octet-stream" : att.contentType;
    res.setHeader("Content-Type", type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
    res.send(att.content);
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};