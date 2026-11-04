import { normalizeMessageContent, downloadMediaMessage, decryptPollVote, jidNormalizedUser } from '@whiskeysockets/baileys';
import prisma from '../config/prismaClient.js';
import ApiError from '../utils/ApiError.js';
import pino from 'pino';
import cloudinary from '../config/cloudinary.js';
import crypto from 'crypto';

//HELPERS

const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // skip downloading anything bigger

const keyOf = (v) => String(v || '').replace(/\D/g, '').slice(-10);

const parse = (m) => {
    const c = normalizeMessageContent(m.message);
    if (!c) return null;
    if (c.conversation) return { type: 'text', body: c.conversation };
    if (c.extendedTextMessage) return { type: 'text', body: c.extendedTextMessage.text || '' };
    if (c.imageMessage) return { type: 'image', body: c.imageMessage.caption || '', media: c.imageMessage };
    if (c.videoMessage) return { type: 'video', body: c.videoMessage.caption || '', media: c.videoMessage };
    if (c.documentMessage)
        return { type: 'document', body: c.documentMessage.caption || '', fileName: c.documentMessage.fileName, media: c.documentMessage };
    if (c.audioMessage) return { type: 'audio', body: '', media: c.audioMessage };
    if (c.stickerMessage) return { type: 'sticker', body: '', media: c.stickerMessage };
    if (c.locationMessage) {
        const l = c.locationMessage;
        return { type: 'location', body: l.name || l.address || '', lat: l.degreesLatitude, lng: l.degreesLongitude };
    }
    const poll = c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3;
    if (poll) {
        const secret = m.message?.messageContextInfo?.messageSecret || c.messageContextInfo?.messageSecret;
        return {
            type: 'poll',
            body: poll.name || '',
            pollOptions: (poll.options || []).map((o) => o.optionName),
            pollSecret: secret ? Buffer.from(secret).toString('base64') : null,
        };
    }
    return null;
};

const uploadMedia = async (m, parsed, sock) => {
    try {
        if (Number(String(parsed.media.fileLength)) > MAX_MEDIA_BYTES) return null;

        const buffer = await downloadMediaMessage(m, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
        });

        // documents go up as "raw" so the file keeps its real name/extension in the URL
        const opts =
            parsed.type === 'document'
                ? { resource_type: 'raw', public_id: `whatsapp-inbox/${Date.now()}-${(parsed.fileName || 'file').replace(/[^\w.\-]/g, '_')}` }
                : { resource_type: 'auto', folder: 'whatsapp-inbox' };

        return await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(opts, (err, r) => (err ? reject(err) : resolve(r.secure_url))).end(buffer);
        });
    } catch (e) {
        console.error('WhatsApp media upload failed:', e.message);
        return null;
    }
};

const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const norm = (j) => (j ? jidNormalizedUser(j) : null); // strips the :device suffix

// Returns true if the message is a poll vote (handled or not), so the caller stops.
const handlePollVote = async (adminId, m, sock, emit) => {
    const upd = normalizeMessageContent(m.message)?.pollUpdateMessage;
    if (!upd) return false;
    if (m.key.remoteJid?.endsWith('@g.us')) return true;

    const creationKey = upd.pollCreationMessageKey;
    const row = await prisma.whatsAppMessage.findUnique({
        where: { adminId_waId: { adminId, waId: creationKey.id } },
    });
    if (!row || row.type !== 'poll' || !row.pollSecret) return true; // poll predates secret storage

    const pollEncKey = Buffer.from(row.pollSecret, 'base64');

    // All identities each side might be encrypted under (LID first, then phone number)
    const me = uniq([norm(sock.user?.lid || sock.authState?.creds?.me?.lid), norm(sock.user?.id)]);
    const them = uniq([m.key.remoteJid, m.key.remoteJidAlt, m.key.participant, m.key.participantAlt].map(norm));

    const creators = row.fromMe ? me : them;
    const voters = m.key.fromMe ? me : them;

    let vote = null;
    for (const pollCreatorJid of creators) {
        for (const voterJid of voters) {
            try {
                vote = decryptPollVote(upd.vote, { pollEncKey, pollCreatorJid, pollMsgId: creationKey.id, voterJid });
                break;
            } catch { /* wrong JID pair, try the next one */ }
        }
        if (vote) break;
    }
    if (!vote) return true;

    const options = row.pollOptions || [];
    const hashes = (vote.selectedOptions || []).map((h) => Buffer.from(h).toString('hex'));
    const votes = {
        ...(row.pollVotes || {}),
        [m.key.fromMe ? 'me' : 'them']: options.filter((o) => hashes.includes(sha(o))),
    };

    await prisma.whatsAppMessage.update({ where: { id: row.id }, data: { pollVotes: votes } });
    emit(adminId, 'whatsapp:poll_votes', { waId: row.waId, pollVotes: votes });
    return true;
};


const RANK = { sent: 1, delivered: 2, read: 3 };
const toStatus = (n) => (n >= 4 ? 'read' : n === 3 ? 'delivered' : 'sent');
const higher = (a, b) => (RANK[b] > RANK[a] ? b : a);

// statuses that arrived before their message row was saved
const pendingStatus = new Map(); // waId -> status

const applyStatus = async (adminId, waId, status, emit) => {
    const row = await prisma.whatsAppMessage.findUnique({
        where: { adminId_waId: { adminId, waId } },
        select: { id: true, status: true },
    });

    if (!row) {
        // row not saved yet: remember it, saveWhatsAppMessage will pick it up
        pendingStatus.set(waId, higher(pendingStatus.get(waId) || 'sent', status));
        if (pendingStatus.size > 500) pendingStatus.delete(pendingStatus.keys().next().value);
        return;
    }

    if (RANK[status] <= RANK[row.status]) return; // never go backwards
    await prisma.whatsAppMessage.update({ where: { id: row.id }, data: { status } });
    emit(adminId, 'whatsapp:message_status', { waId, status });
};




//controllers

export const getStoredMessage = async (adminId, key) => {
    if (!key?.id) return undefined;
    const row = await prisma.whatsAppMessage.findUnique({
        where: { adminId_waId: { adminId, waId: key.id } },
        select: { type: true, body: true, pollOptions: true, pollSecret: true },
    });
    if (!row || row.type !== 'poll' || !row.pollSecret) return undefined;
    return {
        messageContextInfo: { messageSecret: Buffer.from(row.pollSecret, 'base64') },
        pollCreationMessage: {
            name: row.body,
            options: (row.pollOptions || []).map((optionName) => ({ optionName })),
        },
    };
};

// Called from baileys.js on every messages.upsert
export const saveWhatsAppMessage = async (adminId, m, emit, sock) => {
    if (await handlePollVote(adminId, m, sock, emit)) return;
    const jid = m.key.remoteJidAlt?.endsWith('@s.whatsapp.net') ? m.key.remoteJidAlt : m.key.remoteJid;
    if (!jid?.endsWith('@s.whatsapp.net')) return;

    const parsed = parse(m);
    if (!parsed) return;

    const waId = m.key.id;
    const fromMe = !!m.key.fromMe;

    let mediaUrl = null;
    if (parsed.media) {
        // don't download the same file twice if Baileys delivers the message again
        const exists = await prisma.whatsAppMessage.findUnique({
            where: { adminId_waId: { adminId, waId } },
            select: { id: true },
        });
        if (exists) return;
        mediaUrl = await uploadMedia(m, parsed, sock);
    }

    // a receipt may already be merged into the upsert, or may have arrived before we got here
    let status = 'sent';
    if (fromMe) {
        if (typeof m.status === 'number') status = higher(status, toStatus(m.status));
        status = higher(status, pendingStatus.get(waId) || 'sent');
        pendingStatus.delete(waId);
    }

    try {
        const row = await prisma.whatsAppMessage.create({
            data: {
                adminId,
                phoneKey: keyOf(jid.split('@')[0]),
                waId,
                fromMe,
                type: parsed.type,
                body: parsed.body,
                fileName: parsed.fileName || null,
                mediaUrl,
                lat: parsed.lat ?? null,
                lng: parsed.lng ?? null,
                pollOptions: parsed.pollOptions ?? undefined,
                status,
                isRead: fromMe,
                pollSecret: parsed.pollSecret ?? null,
                timestamp: new Date(Number(m.messageTimestamp || Date.now() / 1000) * 1000),
            },
        });
        if (row.type === 'poll') console.log('📊 poll saved', row.waId, 'hasSecret:', !!row.pollSecret);
        emit(adminId, 'whatsapp:message', row);
    } catch (e) {
        if (e.code !== 'P2002') console.error('saveWhatsAppMessage:', e.message);
    }
};

// Called from baileys.js on messages.update (✓ delivered / ✓✓ read ticks)
const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');

export const updateWhatsAppStatus = async (adminId, updates, emit) => {
    for (const u of updates) {
        const waId = u.key?.id;
        if (!waId) continue;

        // ✓ delivered / ✓✓ read ticks
        const st = u.update?.status;
        if (st && u.key.fromMe) await applyStatus(adminId, waId, toStatus(st), emit);

        // poll votes (selectedOptions are SHA-256 hashes of the option names)
        const pollUpdates = u.update?.pollUpdates;
        console.log('🗳️ pollUpdates decrypted', waId, pollUpdates.length);
        if (pollUpdates?.length) {
            const row = await prisma.whatsAppMessage.findUnique({ where: { adminId_waId: { adminId, waId } } });
            if (!row || row.type !== 'poll') continue;

            const options = row.pollOptions || [];
            const votes = { ...(row.pollVotes || {}) };
            for (const p of pollUpdates) {
                const voter = p.pollUpdateMessageKey?.fromMe ? 'me' : 'them'; // 1-to-1 chat: only two voters
                const hashes = (p.vote?.selectedOptions || []).map((h) => Buffer.from(h).toString('hex'));
                votes[voter] = options.filter((o) => hashes.includes(sha(o)));
            }

            await prisma.whatsAppMessage.update({ where: { id: row.id }, data: { pollVotes: votes } });
            emit(adminId, 'whatsapp:poll_votes', { waId, pollVotes: votes });
        }
    }
};

// GET /whatsapp/inbox/summary → last message + unread count per chat
export const getInboxSummary = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const [last, unread] = await Promise.all([
            prisma.whatsAppMessage.findMany({
                where: { adminId },
                orderBy: { timestamp: 'desc' },
                distinct: ['phoneKey'],
                select: { phoneKey: true, body: true, type: true, fromMe: true, timestamp: true },
            }),
            prisma.whatsAppMessage.groupBy({
                by: ['phoneKey'],
                where: { adminId, fromMe: false, isRead: false },
                _count: { _all: true },
            }),
        ]);
        const unreadMap = Object.fromEntries(unread.map((u) => [u.phoneKey, u._count._all]));
        res.json({ success: true, chats: last.map((l) => ({ ...l, unread: unreadMap[l.phoneKey] || 0 })) });
    } catch (err) {
        next(new ApiError(500, err.message));
    }
};

// GET /whatsapp/inbox/chat/:phoneKey?before=<ISO>  → 50 messages per page, oldest first
export const getChatMessages = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const phoneKey = keyOf(req.params.phoneKey);
        const limit = 50;
        const { before } = req.query;

        const rows = await prisma.whatsAppMessage.findMany({
            where: { adminId, phoneKey, ...(before ? { timestamp: { lt: new Date(before) } } : {}) },
            orderBy: { timestamp: 'desc' },
            take: limit,
        });

        if (!before) {
            await prisma.whatsAppMessage.updateMany({
                where: { adminId, phoneKey, fromMe: false, isRead: false },
                data: { isRead: true },
            });
        }
        res.json({ success: true, messages: rows.reverse(), hasMore: rows.length === limit });
    } catch (err) {
        next(new ApiError(500, err.message));
    }
};

// POST /whatsapp/inbox/chat/:phoneKey/read
export const markChatRead = async (req, res, next) => {
    try {
        await prisma.whatsAppMessage.updateMany({
            where: { adminId: req.admin.id, phoneKey: keyOf(req.params.phoneKey), fromMe: false, isRead: false },
            data: { isRead: true },
        });
        res.json({ success: true });
    } catch (err) {
        next(new ApiError(500, err.message));
    }
};



// DELETE /whatsapp/inbox/chat/:phoneKey → deletes this admin's saved history with one customer
export const deleteChat = async (req, res, next) => {
    try {
        const { count } = await prisma.whatsAppMessage.deleteMany({
            where: { adminId: req.admin.id, phoneKey: keyOf(req.params.phoneKey) },
        });
        res.json({ success: true, deleted: count });
    } catch (err) {
        next(new ApiError(500, err.message));
    }
};