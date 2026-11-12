import nodemailer from "nodemailer";
import { decryptSecret } from "./emailCrypto.js";
import { buildSmtpOptions } from "./emailConnect.js";
import prisma from "../../config/prismaClient.js";


/**
 * Per-admin pooled transporters.
 *  - The DB row is read on every send (one indexed lookup) and compared by `updatedAt`,
 *    so a password change on ANY server instance / PM2 worker takes effect immediately.
 *  - Idle transporters are closed after 10 minutes so many admins don't leave sockets open.
 */
const cache = new Map(); // adminId -> { stamp, transporter, meta, lastUsed }
const IDLE_MS = 10 * 60 * 1000;

const closeEntry = (entry) => {
  try { entry.transporter.close(); } catch { /* ignore */ }
};

export const invalidateAdminMailer = (adminId) => {
  const entry = cache.get(adminId);
  if (entry) closeEntry(entry);
  cache.delete(adminId);
};

setInterval(() => {
  const now = Date.now();
  for (const [adminId, entry] of cache) {
    if (now - entry.lastUsed > IDLE_MS) {
      closeEntry(entry);
      cache.delete(adminId);
    }
  }
}, 60_000).unref();

/**
 * Returns null when the admin has no (active) connected mailbox -> caller falls back to the
 * default .env mailbox exactly like before.
 * THROWS if a config exists but cannot be used (e.g. cannot decrypt): we never silently send
 * customer emails from a different sender than the admin expects.
 */
export const getAdminMailer = async (adminId) => {
  if (!adminId) return null;

  const row = await prisma.adminEmailConfig.findUnique({ where: { adminId } });
  if (!row || !row.isActive) {
    invalidateAdminMailer(adminId);
    return null;
  }

  const stamp = row.updatedAt.getTime();
  let entry = cache.get(adminId);

  if (!entry || entry.stamp !== stamp) {
    if (entry) closeEntry(entry);
    const pass = decryptSecret(row.smtpPassEnc);
    const imapPass = row.imapPassEnc ? decryptSecret(row.imapPassEnc) : pass; // separate IMAP password if the admin set one
    const transporter = nodemailer.createTransport(
      buildSmtpOptions(
        { host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure },
        { user: row.smtpUser, pass },
        { pooled: true }
      )
    );
    entry = {
      stamp,
      transporter,
      lastUsed: Date.now(),
      meta: {
        email: row.email,
        fromName: row.fromName,
        saveToSent: row.saveToSent && !!row.imapHost && !!row.sentFolder,
        imap: row.imapHost
          ? { host: row.imapHost, port: row.imapPort, secure: row.imapSecure, user: row.imapUser || row.smtpUser, pass: imapPass, folder: row.sentFolder }
          : null,
      },
    };
    cache.set(adminId, entry);
  }

  entry.lastUsed = Date.now();
  return { transporter: entry.transporter, ...entry.meta };
};