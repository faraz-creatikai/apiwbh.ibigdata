import { serverUrl } from "../config/cors-origins.js";
import prisma from "../config/prismaClient.js";

const DAY = 864e5;
const seesAll = (a) => a.isSuperAdmin || a.role === "administrator";

/* ───────── recording (never throws, so tracking can't break a send) ───────── */
export const recordSend = (data) =>
  prisma.channelMessage.create({ data }).catch((e) => console.error("tracking failed:", e.message));

export const trackingPixel = (id) => {
  const base = `${serverUrl}/api/channel-tracking`; // TODO: use public host
  return base ? `<img src="${base}/o/${id}.gif" width="1" height="1" alt="" style="border:0;width:1px;height:1px;">` : "";
};

/* ───────── email: open (called by the public pixel route) ───────── */
export const trackOpen = async (id) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  await prisma.channelMessage.updateMany({ where: { id, channel: "email" }, data: { openCount: { increment: 1 } } });
  await prisma.channelMessage.updateMany({ where: { id, channel: "email", openedAt: null }, data: { openedAt: new Date() } });
};

/* ───────── email: replies + bounces (run after each inbox sync) ───────── */
export const trackEmailInbox = async (adminId) => {
  const since = new Date(Date.now() - 14 * DAY);
  const pending = await prisma.channelMessage.findMany({
    where: {
      adminId, channel: "email", status: "sent", sentAt: { gte: since }, providerMessageId: { not: null },
      OR: [{ repliedAt: null }, { bouncedAt: null }],
    },
    select: { id: true, providerMessageId: true, repliedAt: true, bouncedAt: true },
    take: 500,
  });
  if (!pending.length) return;

  // replies: their References header contains the Message-ID we sent
  const withRefs = await prisma.emailMessage.findMany({
    where: { adminId, folder: "INBOX", date: { gte: since }, refs: { not: null } },
    select: { refs: true }, take: 1000,
  });
  // bounces: mail from the mail system that quotes our Message-ID
  const bounces = await prisma.emailMessage.findMany({
    where: { adminId, folder: "INBOX", date: { gte: since }, OR: [{ fromEmail: { contains: "mailer-daemon" } }, { fromEmail: { contains: "postmaster" } }] },
    select: { bodyText: true }, take: 200,
  });

  const now = new Date();
  for (const p of pending) {
    if (!p.repliedAt && withRefs.some((m) => m.refs.includes(p.providerMessageId))) {
      await prisma.channelMessage.update({ where: { id: p.id }, data: { repliedAt: now } });
    } else if (!p.bouncedAt && bounces.some((m) => m.bodyText?.includes(p.providerMessageId))) {
      await prisma.channelMessage.update({ where: { id: p.id }, data: { bouncedAt: now } });
    }
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
export const channelStats = async (admin, channel, days = 30) => {
  const where = { channel, sentAt: { gte: new Date(Date.now() - days * DAY) }, ...(seesAll(admin) ? {} : { adminId: admin.id }) };
  const c = (extra) => prisma.channelMessage.count({ where: { ...where, ...extra } });
  const [sent, failed, delivered, opened, replied, bounced] = await Promise.all([
    c({ status: "sent" }), c({ status: "failed" }), c({ deliveredAt: { not: null } }),
    c({ openedAt: { not: null } }), c({ repliedAt: { not: null } }), c({ bouncedAt: { not: null } }),
  ]);
  // SMTP has no delivery receipt, so for email "delivered" = sent minus bounced
  return { sent, failed, bounced, opened, replied, delivered: channel === "email" ? Math.max(0, sent - bounced) : delivered };
};