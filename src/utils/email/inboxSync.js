// utils/email/inboxSync.js
//
// Incoming-mail engine. Works with ANY provider because it reuses the IMAP settings that
// detectAndVerify() already discovered and stored on AdminEmailConfig.
//
//   npm i mailparser sanitize-html
//
// Design:
//  - Poll, don't hold connections: one short IMAP session per mailbox per tick (no 1-socket-per-admin).
//  - Incremental by UID cursor (EmailInboxSyncState.lastUid). First run backfills the newest 200 only.
//  - A DB lease (lockUntil) means PM2 workers / multiple servers never sync the same mailbox twice.
//    Even if they did, @@unique([adminId, folder, uid]) + skipDuplicates keeps data correct.
//  - Each tick also reconciles read/starred flags and server-side deletions for the latest 200 messages.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import prisma from "../../config/prismaClient.js";
import { decryptSecret } from "./emailCrypto.js";
import { assertPublicHost } from "./emailProviders.js";
import { trackEmailInbox } from "../channelTracking.js";

const FOLDER = "INBOX";
const INTERVAL_MS = Number(process.env.INBOX_SYNC_INTERVAL_MS) || 60_000;
const CONCURRENCY = 3; // mailboxes synced in parallel per tick
const INITIAL_LIMIT = 200; // first sync: newest N messages
const MAX_PER_RUN = 200; // later syncs: oldest-first, so a big burst is drained over a few ticks
const CHUNK = 25;
const MAX_SOURCE = 5 * 1024 * 1024; // don't pull more than 5MB of a single message during sync
const MAX_BODY = 500_000;
const LOCK_MS = 3 * 60_000;
const RETRY_MS = 2 * 60_000;
const AUTH_RETRY_MS = 30 * 60_000; // don't hammer a provider with a wrong password

/* ------------------------------ IMAP plumbing ------------------------------ */

const openImap = async (row) => {
  if (!row.imapHost) throw new Error("Inbox is not available for this mailbox. Please reconnect your email.");
  await assertPublicHost(row.imapHost); // re-check at use time (SSRF / DNS rebinding)
  const client = new ImapFlow({
    host: row.imapHost,
    port: row.imapPort,
    secure: !!row.imapSecure,
    auth: { user: row.imapUser || row.smtpUser, pass: decryptSecret(row.smtpPassEnc) },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  client.on("error", () => {}); // an unhandled ImapFlow 'error' event would crash the process
  await client.connect();
  return client;
};

const closeImap = async (client) => {
  try { await client.logout(); } catch { /* ignore */ }
  try { client.close(); } catch { /* ignore */ }
};

/** Opens a session, locks INBOX, runs fn(client), always cleans up. */
const withInbox = async (adminId, fn) => {
  const row = await prisma.adminEmailConfig.findUnique({ where: { adminId } });
  if (!row || !row.isActive) throw new Error("No email connected");
  const client = await openImap(row);
  try {
    const lock = await client.getMailboxLock(FOLDER);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await closeImap(client);
  }
};

/* ------------------------------ parsing ------------------------------ */

const nz = (s) => String(s ?? "").replace(/\u0000/g, ""); // Postgres rejects NUL bytes

const V = /^[#\w\s(),.%!'"-]+$/;
const SAFE_STYLES = {
  "*": Object.fromEntries(
    ["color", "background-color", "text-align", "font-size", "font-weight", "font-style", "font-family",
      "text-decoration", "line-height", "padding", "margin", "width", "height", "border"].map((p) => [p, [V]])
  ),
};

const cleanHtml = (html) =>
  sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "center"]),
    allowedAttributes: {
      a: ["href", "name", "title", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      "*": ["style", "align", "bgcolor", "width", "height", "colspan", "rowspan", "valign", "border", "cellpadding", "cellspacing"],
    },
    allowedStyles: SAFE_STYLES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    transformTags: { a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer nofollow" }) },
  });

const addrs = (field) =>
  []
    .concat(field || [])
    .flatMap((o) => o.value || [])
    .map((a) => ({ name: nz(a.name), address: nz(a.address).toLowerCase() }))
    .filter((a) => a.address);

const toRow = async (adminId, msg) => {
  const parsed = await simpleParser(msg.source);

  // inline images (cid:) -> small data URIs so they render without extra requests
  let html = parsed.html || "";
  if (html) {
    for (const a of parsed.attachments || []) {
      const cid = a.contentId?.replace(/[<>]/g, "");
      if (cid && a.contentType?.startsWith("image/") && a.size < 300_000) {
        html = html.replaceAll(`cid:${cid}`, `data:${a.contentType};base64,${a.content.toString("base64")}`);
      }
    }
    html = cleanHtml(html);
  }

  const text = nz(parsed.text || (html ? sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }) : ""));
  const from = addrs(parsed.from)[0] || { name: "", address: "unknown" };
  const refs = [].concat(parsed.references || []);
  const attachments = (parsed.attachments || []).map((a, index) => ({
    index,
    filename: nz(a.filename) || `attachment-${index + 1}`,
    contentType: a.contentType,
    size: a.size,
    inline: a.contentDisposition === "inline" && !!a.contentId,
  }));

  const date = parsed.date || msg.internalDate || new Date();

  return {
    adminId,
    folder: FOLDER,
    uid: msg.uid,
    messageId: parsed.messageId || null,
    threadKey: nz(refs[0] || parsed.inReplyTo || parsed.messageId || `uid-${msg.uid}`).slice(0, 500),
    refs: refs.length ? nz(refs.join(" ")) : null,
    fromEmail: from.address,
    fromName: from.name || null,
    toList: addrs(parsed.to),
    ccList: addrs(parsed.cc),
    subject: nz(parsed.subject || "(no subject)").slice(0, 998),
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
    bodyText: text.slice(0, MAX_BODY) || null,
    bodyHtml: nz(html).slice(0, MAX_BODY) || null,
    attachments,
    hasAttachments: attachments.some((a) => !a.inline),
    date: isNaN(new Date(date)) ? new Date() : new Date(date),
    isRead: msg.flags?.has("\\Seen") ?? false,
    isStarred: msg.flags?.has("\\Flagged") ?? false,
  };
};

/* ------------------------------ sync ------------------------------ */

const claim = async (adminId) => {
  try {
    await prisma.emailInboxSyncState.upsert({ where: { adminId }, create: { adminId }, update: {} });
  } catch { /* concurrent first-time create: the row exists now */ }
  const now = new Date();
  const r = await prisma.emailInboxSyncState.updateMany({
    where: { adminId, OR: [{ lockUntil: null }, { lockUntil: { lt: now } }] },
    data: { lockUntil: new Date(now.getTime() + LOCK_MS) },
  });
  return r.count === 1;
};

/** Pull read/starred changes and server-side deletions for the latest 200 stored messages. */
const reconcile = async (client, adminId) => {
  const recent = await prisma.emailMessage.findMany({
    where: { adminId, folder: FOLDER },
    orderBy: { uid: "desc" },
    take: 200,
    select: { id: true, uid: true, isRead: true, isStarred: true },
  });
  if (!recent.length) return;

  const seen = new Map();
  for await (const m of client.fetch(recent.map((r) => r.uid).join(","), { uid: true, flags: true }, { uid: true })) {
    seen.set(m.uid, m.flags);
  }
  if (!seen.size) return; // never wipe local data on an empty/failed answer

  const gone = [];
  for (const r of recent) {
    const flags = seen.get(r.uid);
    if (!flags) { gone.push(r.id); continue; }
    const isRead = flags.has("\\Seen");
    const isStarred = flags.has("\\Flagged");
    if (isRead !== r.isRead || isStarred !== r.isStarred) {
      await prisma.emailMessage.update({ where: { id: r.id }, data: { isRead, isStarred } });
    }
  }
  if (gone.length) await prisma.emailMessage.deleteMany({ where: { id: { in: gone } } });
};

/** Never throws. Returns { added } | { skipped } | { error }. */
export const syncInbox = async (adminId) => {
  const cfg = await prisma.adminEmailConfig.findUnique({ where: { adminId }, select: { isActive: true, imapHost: true } });
  if (!cfg?.isActive || !cfg.imapHost) return { skipped: "inbox_unavailable" };
  if (!(await claim(adminId))) return { skipped: "busy" };

  let holdMs = 0;
  try {
    const added = await withInbox(adminId, async (client) => {
      const state = await prisma.emailInboxSyncState.findUnique({ where: { adminId } });
      const validity = String(client.mailbox.uidValidity);
      let lastUid = state.lastUid;

      if (state.uidValidity && state.uidValidity !== validity) {
        await prisma.emailMessage.deleteMany({ where: { adminId, folder: FOLDER } });
        lastUid = 0;
      }
      await prisma.emailInboxSyncState.update({ where: { adminId }, data: { uidValidity: validity, lastUid } });

      // IMAP "n:*" always returns at least the last message, hence the explicit > lastUid filter
      let uids = (await client.search(lastUid ? { uid: `${lastUid + 1}:*` } : { all: true }, { uid: true })) || [];
      uids = uids.filter((u) => u > lastUid).sort((a, b) => a - b);
      uids = lastUid ? uids.slice(0, MAX_PER_RUN) : uids.slice(-INITIAL_LIMIT);

      let count = 0;
      for (let i = 0; i < uids.length; i += CHUNK) {
        const chunk = uids.slice(i, i + CHUNK);
        const rows = [];
        // no other IMAP command may run inside this loop (it would deadlock) — we only parse here
        for await (const msg of client.fetch(
          chunk.join(","),
          { uid: true, flags: true, internalDate: true, source: { maxLength: MAX_SOURCE } },
          { uid: true }
        )) {
          try {
            if (msg.source) rows.push(await toRow(adminId, msg));
          } catch (e) {
            console.error(`inbox: skipped uid ${msg.uid} for ${adminId}: ${e.message}`);
          }
        }
        if (rows.length) count += (await prisma.emailMessage.createMany({ data: rows, skipDuplicates: true })).count;
        await prisma.emailInboxSyncState.update({ where: { adminId }, data: { lastUid: chunk[chunk.length - 1] } });
      }

      await reconcile(client, adminId);
      return count;
    });

    await prisma.emailInboxSyncState.update({ where: { adminId }, data: { lastSyncAt: new Date(), lastError: null } });
    trackEmailInbox(adminId).catch(() => {});
    return { added };
  } catch (err) {
    holdMs = err.authenticationFailed ? AUTH_RETRY_MS : RETRY_MS;
    const msg = err.authenticationFailed ? "The mail server rejected the login. Please reconnect your email." : err.message;
    await prisma.emailInboxSyncState.update({ where: { adminId }, data: { lastError: String(msg).slice(0, 500) } }).catch(() => {});
    return { error: msg };
  } finally {
    // success -> release; failure -> keep the lease as a retry back-off
    await prisma.emailInboxSyncState
      .update({ where: { adminId }, data: { lockUntil: holdMs ? new Date(Date.now() + holdMs) : null } })
      .catch(() => {});
  }
};

/* ------------------------------ background worker ------------------------------ */

/** Call once at server start. Set INBOX_SYNC=off on instances that should not sync. */
export const startInboxWorker = () => {
  if (process.env.INBOX_SYNC === "off") return;

  const tick = async () => {
    try {
      const rows = await prisma.adminEmailConfig.findMany({
        where: { isActive: true, imapHost: { not: null } },
        select: { adminId: true },
      });
      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        await Promise.all(rows.slice(i, i + CONCURRENCY).map((r) => syncInbox(r.adminId)));
      }
    } catch (e) {
      console.error("inbox worker tick failed:", e.message);
    }
    setTimeout(tick, INTERVAL_MS).unref();
  };
  setTimeout(tick, 15_000).unref();
};

/* ------------------------------ on-demand actions ------------------------------ */

/** Mirror read/starred changes to the server (best effort; the DB is already updated). */
export const pushFlags = (adminId, uids, { isRead, isStarred }) =>
  withInbox(adminId, async (client) => {
    const set = uids.join(",");
    const apply = async (flag, on) =>
      client[on ? "messageFlagsAdd" : "messageFlagsRemove"](set, [flag], { uid: true });
    if (isRead !== undefined) await apply("\\Seen", isRead);
    if (isStarred !== undefined) await apply("\\Flagged", isStarred);
  });

/** Attachments aren't stored: re-fetch the message and pick the attachment by its saved index. */
export const fetchAttachment = (adminId, uid, index) =>
  withInbox(adminId, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg?.source) return null;
    const parsed = await simpleParser(msg.source);
    const a = parsed.attachments?.[index];
    return a ? { filename: a.filename || `attachment-${index + 1}`, contentType: a.contentType, content: a.content } : null;
  });