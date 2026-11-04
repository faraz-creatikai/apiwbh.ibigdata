import { z } from "zod";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { invalidateAdminMailer } from "../utils/email/AdminMailerConfig.js";
import { detectAndVerify, verifySmtp  } from "../utils/email/emailConnect.js";
import { encryptSecret, decryptSecret } from "../utils/email/emailCrypto.js";
import { sendEmail } from "../config/mailer.js";


/* Only one detection per admin at a time (it opens outbound connections). */
const inFlight = new Set();

const bodySchema = z.object({
  email: z.string().trim().email("Enter a valid email address").max(254),
  password: z.string().min(1, "Password is required").max(512),
  fromName: z.string().trim().max(100).optional(),
  // Fallback only — shown by the UI when detection answers needsAdvanced:true
  advanced: z
    .object({
      smtpHost: z.string().trim().min(1).max(255),
      smtpPort: z.coerce.number().int().min(1).max(65535),
      smtpUser: z.string().trim().max(254).optional(),
      imapHost: z.string().trim().max(255).optional(),
      imapPort: z.coerce.number().int().min(1).max(65535).optional(),
    })
    .optional(),
});

/** Never expose the encrypted password. */
const toPublic = (row) =>
  row && {
    connected: row.isActive,
    email: row.email,
    fromName: row.fromName,
    provider: row.provider,
    providerLabel: row.providerLabel,
    smtp: { host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure },
    saveToSent: row.saveToSent,
    sentFolder: row.sentFolder,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };

const parseBody = (req, next) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new ApiError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return null;
  }
  return parsed.data;
};

/** Runs detection while holding the per-admin lock. Returns the result or null if busy. */
const runDetection = async (adminId, data) => {
  if (inFlight.has(adminId)) return null;
  inFlight.add(adminId);
  try {
    return await detectAndVerify(data);
  } finally {
    inFlight.delete(adminId);
  }
};

// GET /email-connection
export const getEmailConnection = async (req, res, next) => {
  try {
    const row = await prisma.adminEmailConfig.findUnique({ where: { adminId: req.admin.id } });
    res.json({ success: true, connection: row ? toPublic(row) : { connected: false } });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

// POST /email-connection/test  — detect + verify only, saves nothing
export const testEmailConnection = async (req, res, next) => {
  try {
    const data = parseBody(req, next);
    if (!data) return;

    const result = await runDetection(req.admin.id, data);
    if (!result) return next(new ApiError(429, "A connection check is already running. Please wait a moment."));
    if (!result.ok) return res.status(422).json({ success: false, ...result });

    const { password, tried, ...safe } = result; // eslint-disable-line no-unused-vars
    res.json({ success: true, detected: safe });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

// POST /email-connection  — detect + verify + save (upsert)
export const connectEmail = async (req, res, next) => {
  try {
    const data = parseBody(req, next);
    if (!data) return;

    const result = await runDetection(req.admin.id, data);
    if (!result) return next(new ApiError(429, "A connection check is already running. Please wait a moment."));
    if (!result.ok) return res.status(422).json({ success: false, ...result });

    const email = String(data.email).trim().toLowerCase();
    const fields = {
      email,
      fromName: data.fromName || req.admin.name || email.split("@")[0],
      provider: result.provider,
      providerLabel: result.providerLabel,
      smtpHost: result.smtp.host,
      smtpPort: result.smtp.port,
      smtpSecure: result.smtp.secure,
      smtpUser: result.smtp.user,
      smtpPassEnc: encryptSecret(result.password), // throws a clear error if EMAIL_CONFIG_SECRET is missing
      saveToSent: result.saveToSent,
      imapHost: result.imap?.host ?? null,
      imapPort: result.imap?.port ?? null,
      imapSecure: result.imap?.secure ?? null,
      imapUser: result.imap?.user ?? null,
      sentFolder: result.sentFolder ?? null,
      isActive: true,
      status: "connected",
      lastVerifiedAt: new Date(),
      lastError: null,
    };

    const row = await prisma.adminEmailConfig.upsert({
      where: { adminId: req.admin.id },
      create: { adminId: req.admin.id, ...fields },
      update: fields,
    });
    invalidateAdminMailer(req.admin.id);

    res.status(200).json({
      success: true,
      message: `Connected ${row.email} (${row.providerLabel})`,
      warnings: result.warnings,
      connection: toPublic(row),
    });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

// POST /email-connection/verify  — re-check the saved mailbox (e.g. after a password change at the provider)
export const verifyEmailConnection = async (req, res, next) => {
  try {
    const row = await prisma.adminEmailConfig.findUnique({ where: { adminId: req.admin.id } });
    if (!row) return next(new ApiError(404, "No email connected"));

    const r = await verifySmtp(
      { host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure },
      { user: row.smtpUser, pass: decryptSecret(row.smtpPassEnc) }
    );

    const updated = await prisma.adminEmailConfig.update({
      where: { adminId: req.admin.id },
      data: r.ok
        ? { status: "connected", lastVerifiedAt: new Date(), lastError: null }
        : { status: "failed", lastError: r.message },
    });
    invalidateAdminMailer(req.admin.id);

    res.status(r.ok ? 200 : 422).json({ success: r.ok, connection: toPublic(updated) });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

export const sendTestEmail = async (req, res, next) => {
  try {
    const row = await prisma.adminEmailConfig.findUnique({ where: { adminId: req.admin.id } });
    if (!row || !row.isActive) return next(new ApiError(404, "No email connected"));

    const info = await sendEmail(
      row.email,
      "Test email from your CRM",
      "<p>This is a test. If you can read this, your mailbox is sending correctly.</p>",
      { adminId: req.admin.id }
    );
    res.json({
      success: true,
      message: `Test email sent to ${row.email}.`,
      sentCopy: info.sentCopy,
      sentCopyError: info.sentCopyError,
    });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

// DELETE /email-connection  — disconnect; sending falls back to the default mailbox
export const disconnectEmail = async (req, res, next) => {
  try {
    await prisma.adminEmailConfig.deleteMany({ where: { adminId: req.admin.id } });
    invalidateAdminMailer(req.admin.id);
    res.json({ success: true, message: "Email disconnected", connection: { connected: false } });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};