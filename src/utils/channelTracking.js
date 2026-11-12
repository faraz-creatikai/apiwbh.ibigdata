import { serverUrl } from "../config/cors-origins.js";
import prisma from "../config/prismaClient.js";

const DAY = 864e5;
const seesAll = (a) => a.isSuperAdmin || a.role === "administrator";

/* ───────── recording (never throws, so tracking can't break a send) ───────── */
export const recordSend = (data) =>
  prisma.channelMessage.create({ data }).catch((e) => console.error("tracking failed:", e.message));

export const trackingPixel = (id) => {
  const base = `${serverUrl}/api/channel-tracking`; // must be a PUBLIC https host, or Gmail can never load the pixel
  return base ? `<img src="${base}/o/${id}.gif" width="1" height="1" alt="" style="border:0;width:1px;height:1px;">` : "";
};


/* ───────── email: open (called by the public pixel route) ───────── */
export const trackOpen = async (id) => {
  // 1. Check if the regex is silently rejecting your ID
  if (!/^[0-9a-f-]{24,36}$/i.test(id)) {
    console.log(`❌ [OPEN REJECTED] ID failed regex check: "${id}"`);
    return;
  }

  // 2. The ID passed! The email client successfully pinged your server.
  console.log(`\n🔔 [OPEN DETECTED] Pixel requested for ID: ${id}`);

  // 3. Attempt the database update and capture the result
  const res = await prisma.channelMessage.updateMany({ 
    where: { id, channel: "email" }, 
    data: { openCount: { increment: 1 } } 
  });

  console.log(`💾 DB Update Result: Modified ${res.count} rows`);

  await prisma.channelMessage.updateMany({ 
    where: { id, channel: "email", openedAt: null }, 
    data: { openedAt: new Date() } 
  });
};

/* ───────── email: replies + bounces (run after each inbox sync) ───────── */
// Message-IDs are compared without <>, spaces and case, because the mailer stores "<id@host>"
// while the inbox sync may store the References header in another shape.
const bare = (s) => String(s || "").replace(/[<>\s]/g, "").toLowerCase();
// Fallback matching (same sender + "Re:" subject) can over-count in the overall stats. Turn on only if exact matching fails.
const REPLY_FALLBACK = false;
const isReplySubject = (s) => /^\s*(re|aw|sv|antw)\s*:/i.test(s || "");

export const trackEmailInbox = async (adminId) => {
  const since = new Date(Date.now() - 14 * DAY);
  const pending = await prisma.channelMessage.findMany({
    where: {
      adminId, channel: "email", status: "sent", sentAt: { gte: since },
      OR: [{ repliedAt: null }, { bouncedAt: null }],
    },
    select: { id: true, recipient: true, sentAt: true, providerMessageId: true, repliedAt: true, bouncedAt: true },
    orderBy: { sentAt: "desc" }, // newest send first: a reply is credited to the latest message we sent before it
    take: 500,
  });
  if (!pending.length) return;

  const fromMailSystem = { OR: [{ fromEmail: { contains: "mailer-daemon" } }, { fromEmail: { contains: "postmaster" } }] };
  const base = { adminId, folder: "INBOX", date: { gte: since } };
  const [inbox, bounces] = await Promise.all([
    prisma.emailMessage.findMany({
      where: { ...base, NOT: fromMailSystem },
      select: { fromEmail: true, subject: true, date: true, refs: true },
      orderBy: { date: "desc" }, take: 2000,
    }),
    prisma.emailMessage.findMany({
      where: { ...base, ...fromMailSystem },
      select: { date: true, bodyText: true },
      orderBy: { date: "desc" }, take: 200,
    }),
  ]);
  const withRefs = inbox.filter((m) => m.refs).map((m) => ({ m, refs: bare(m.refs) }));
  const bounceBodies = bounces.map((b) => ({ b, text: bare(b.bodyText) }));
  const claimed = new Set(); // one incoming mail answers one send

  for (const p of pending) {
    const rcpt = String(p.recipient || "").trim().toLowerCase();
    const id = bare(p.providerMessageId);
    const data = {};

    if (!p.repliedAt) {
      // 1) exact: the reply's References header contains the Message-ID we sent
      let hit = id ? withRefs.find((x) => !claimed.has(x.m) && x.refs.includes(id))?.m : null;
      // 2) fallback, for SMTP servers that replace our Message-ID (Gmail does): same sender, later date, "Re:" subject
      if (!hit && REPLY_FALLBACK) hit = inbox.find((m) => !claimed.has(m) && m.fromEmail === rcpt && m.date > p.sentAt && isReplySubject(m.subject));
      if (hit) { claimed.add(hit); data.repliedAt = hit.date; }
    }

    if (!p.bouncedAt) {
      const hit = bounceBodies.find(
        ({ b, text }) => (id && text.includes(id)) || (rcpt && b.date > p.sentAt && b.date - p.sentAt < DAY && text.includes(bare(rcpt)))
      );
      if (hit) data.bouncedAt = hit.b.date;
    }

    if (Object.keys(data).length) await prisma.channelMessage.update({ where: { id: p.id }, data });
  }
};

/* ───────── WhatsApp (Baileys) ───────── */
// status 3 = delivered, 4 = read, 5 = played
export const trackWhatsAppStatus = async (updates) => {
  const now = new Date();
  for (const u of updates) {
    const status = u.update?.status;
    if (!u.key?.fromMe || !u.key.id || status == null || status < 3) continue;
    const where = { providerMessageId: u.key.id, channel: "whatsapp_baileys" };
    await prisma.channelMessage.updateMany({ where: { ...where, deliveredAt: null }, data: { deliveredAt: now } });
    if (status >= 4) await prisma.channelMessage.updateMany({ where: { ...where, openedAt: null }, data: { openedAt: now } });
  }
};

// a reply = an incoming message from a number we sent to in the last 7 days
const phoneFromKey = async (sock, key) => {
  let jid = key.remoteJid;
  if (jid?.endsWith("@lid")) {
    jid = key.remoteJidAlt || key.senderPn || key.participantPn || null;
    if (!jid) {
      try { jid = await sock?.signalRepository?.lidMapping?.getPNForLID?.(key.remoteJid); } catch { /* ignore */ }
    }
  }
  return jid?.endsWith("@s.whatsapp.net") ? jid.split("@")[0].split(":")[0] : null;
};

export const trackWhatsAppReply = async (adminId, m, sock) => {
  if (m.key?.fromMe) return;
  const phone = await phoneFromKey(sock, m.key);
  console.log("[tracking] incoming from", m.key?.remoteJid, "→", phone); // delete once it works
  if (!phone) return;
  const last = await prisma.channelMessage.findFirst({
    where: { adminId, channel: "whatsapp_baileys", recipient: phone, status: "sent", repliedAt: null, sentAt: { gte: new Date(Date.now() - 7 * DAY) } },
    orderBy: { sentAt: "desc" }, select: { id: true },
  });
  if (last) await prisma.channelMessage.update({ where: { id: last.id }, data: { repliedAt: new Date() } });
};
/* ───────── numbers for the Overview cards ───────── */
/* ───────── numbers for the Overview cards ───────── */
export const channelStats = async (admin, channel, days = 30) => {
  // FIX: Instantly link downloaded replies to campaigns before counting
  if (channel === "email") {
    await trackEmailInbox(admin.id).catch(() => {});
  }

  const where = { channel, sentAt: { gte: new Date(Date.now() - days * DAY) }, ...(seesAll(admin) ? {} : { adminId: admin.id }) };
  const c = (extra) => prisma.channelMessage.count({ where: { ...where, ...extra } });
  const [sent, failed, delivered, opened, replied, bounced] = await Promise.all([
    c({ status: "sent" }), c({ status: "failed" }), c({ deliveredAt: { not: null } }),
    c({ openedAt: { not: null } }), c({ repliedAt: { not: null } }), c({ bouncedAt: { not: null } }),
  ]);
  // SMTP has no delivery receipt, so for email "delivered" = sent minus bounced
  return { sent, failed, bounced, opened, replied, delivered: channel === "email" ? Math.max(0, sent - bounced) : delivered };
};