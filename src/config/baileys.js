// config/baileys.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { getSocket } from '../socket/socket.js';
import fs from 'fs/promises';
import path from 'path';
import pino from 'pino';
import { getStoredMessage, saveWhatsAppMessage, updateWhatsAppStatus } from '../controllers/controller.whatsappInbox.js';

// Verified against Baileys' source (src/Socket/socket.ts, the `genPairQR` loop
// that fires on the `pair-device` stanza):
//   let qrMs = qrTimeout || 60_000   // time to let a QR live
//   qrTimer = setTimeout(genPairQR, qrMs)
//   qrMs = qrTimeout || 20_000       // shorter subsequent qrs
// When `qrTimeout` is left unset (as we do), the FIRST QR of an attempt lives 60s
// and every QR after that lives 20s. Hardcoded in Baileys, not readable from a
// field — so we mirror the two numbers here for reporting purposes only.
const FIRST_QR_TIMEOUT_MS = 60_000;
const SUBSEQUENT_QR_TIMEOUT_MS = 20_000;

// Each admin gets their own auth folder: whatsapp-auth/<adminId>
const AUTH_BASE = 'whatsapp-auth';
const getAuthDir = (adminId) => path.join(AUTH_BASE, adminId);

// ── Per-admin sessions ───────────────────────────────────────────────
// Everything that used to be a module-level variable now lives here,
// one object per admin.
const sessions = new Map(); // adminId -> session

const createSession = () => ({
  currentSocket: null,

  // QR state
  latestQR: null,
  latestQRGeneratedAt: null,
  latestQRRefreshInterval: null, // ms this specific QR frame will live (60_000 or 20_000)

  // Pairing code state
  latestPairingCode: null,
  pairingCodeGeneratedAt: null,
  connectionMethod: 'qr', // 'qr' | 'pairing'
  pendingPhoneNumber: null,

  connectedUserMeta: null,
  intentionallyPaused: false,
  isStarting: false,

  reconnectTimer: null,
  socketGeneration: 0,
});

const getSession = (adminId) => {
  let s = sessions.get(adminId);
  if (!s) {
    s = createSession();
    sessions.set(adminId, s);
  }
  return s;
};

// Events only go to the sockets of the admin who owns this WhatsApp session
// (socket.js joins every admin socket to the `admin:<id>` room).
const emitToAdmin = (adminId, event, payload) => {
  const io = getSocket();
  if (io) io.to(`admin:${adminId}`).emit(event, payload);
};

const clearReconnectTimer = (s) => {
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
};

const resetQRTiming = (s) => {
  s.latestQR = null;
  s.latestQRGeneratedAt = null;
  s.latestQRRefreshInterval = null;
  // pairing state shares the same lifecycle as QR
  s.latestPairingCode = null;
  s.pairingCodeGeneratedAt = null;
};

export const initWhatsApp = async (adminId, options = {}) => {
  if (!adminId) throw new Error('adminId is required');

  const s = getSession(adminId);
  const { method = 'qr', phoneNumber = null } = options;

  if (s.isStarting || s.currentSocket) {
    return;
  }

  s.isStarting = true;
  s.intentionallyPaused = false;
  s.connectionMethod = method;
  s.pendingPhoneNumber = phoneNumber;
  clearReconnectTimer(s);

  const myGeneration = ++s.socketGeneration;
  let version, state, saveCreds;
  try {
    ({ version } = await fetchLatestBaileysVersion());
    ({ state, saveCreds } = await useMultiFileAuthState(getAuthDir(adminId)));
  } catch (err) {
    // Without this reset, isStarting stays true and this admin can never start again.
    s.isStarting = false;
    console.error(`❌ [${adminId}] WhatsApp init failed:`, err);
    throw err;
  }

  const sock = makeWASocket({
    version,
    auth: state,
    markOnlineOnConnect: false,
    getMessage: (key) => getStoredMessage(adminId, key),
    printQRInTerminal: false,
    // Pairing-code linking validates this far more strictly than QR does.
    // A custom string works fine for QR but makes WhatsApp reject the pair with
    // "couldn't link device / check the number" even when the code is correct.
    browser: method === 'pairing' ? Browsers.macOS('Safari') : ['Property CRM', 'Chrome', '1.0.0'],
    defaultQueryTimeoutMs: undefined,
    // NOTE: deliberately NOT setting qrTimeout — see the constants at the top.
    logger: pino({ level: 'warn' })
  });

  let pairingRequestSent = false;

  const requestPairing = async () => {
    if (pairingRequestSent || myGeneration !== s.socketGeneration) return;
    pairingRequestSent = true;

    try {
      let cleanNumber = s.pendingPhoneNumber.replace(/[^0-9]/g, '');

      // A 10-digit or 0-prefixed number produces a valid-looking code that can never link.
      if (cleanNumber.length === 10) cleanNumber = `91${cleanNumber}`;
      else if (cleanNumber.length === 11 && cleanNumber.startsWith('0')) cleanNumber = `91${cleanNumber.slice(1)}`;
      if (cleanNumber.length < 11 || cleanNumber.length > 15) {
        throw new Error(`Invalid phone number for pairing: "${cleanNumber}"`);
      }

      const code = await sock.requestPairingCode(cleanNumber);

      if (myGeneration !== s.socketGeneration) return;

      s.latestPairingCode = code;
      s.pairingCodeGeneratedAt = Date.now();

      console.log(`🔑 [${adminId}] Pairing code generated for ${cleanNumber}: ${code}`);

      emitToAdmin(adminId, 'whatsapp:pairing_code', {
        code,
        generatedAt: s.pairingCodeGeneratedAt,
      });
    } catch (err) {
      console.error(`❌ [${adminId}] Failed to request pairing code:`, err.message);
      pairingRequestSent = false; // allow the client's "resend" to try again
      emitToAdmin(adminId, 'whatsapp:pairing_error', { message: err.message });
    }
  };

  // ⭐ Request the code on a FRESH socket, before Baileys opens a QR pairing
  // session. Waiting for the `qr` event means the server is already mid-QR-pair,
  // so the phone code belongs to a session nobody is listening on — that is the
  // "check the number" alert with a code that looks perfectly correct.
  // The 3s delay lets the noise handshake finish; firing instantly gives a 428.
  if (method === 'pairing' && phoneNumber && !state.creds.registered) {
    setTimeout(() => { requestPairing(); }, 3000);
  }

  sock.ev.on('connection.update', async (update) => {
    if (myGeneration !== s.socketGeneration) return;

    const { connection, lastDisconnect, qr } = update;

    // Only broadcast QR frames when we're actually in QR mode, so pairing-mode
    // sessions don't flash a QR code the UI never shows.
    if (qr && s.connectionMethod !== 'pairing') {
      const now = Date.now();

      // `latestQR` is null exactly when this is the first `qr` event since the
      // last reset — the same condition Baileys' own genPairQR loop uses to
      // decide "first vs subsequent" (see constants at the top).
      const isFirstQrOfAttempt = s.latestQR === null;
      const refreshInterval = isFirstQrOfAttempt ? FIRST_QR_TIMEOUT_MS : SUBSEQUENT_QR_TIMEOUT_MS;

      s.latestQR = qr;
      s.latestQRGeneratedAt = now;
      s.latestQRRefreshInterval = refreshInterval;

      console.log(`📲 [${adminId}] New QR Code generated (expires in ${refreshInterval}ms)`);
      emitToAdmin(adminId, 'whatsapp:qr', {
        qrString: qr,
        generatedAt: s.latestQRGeneratedAt,
        refreshInterval,
      });
    }

    if (connection === 'close') {
      resetQRTiming(s);
      s.connectedUserMeta = null;

      const error = lastDisconnect?.error;
      const statusCode = new Boom(error)?.output?.statusCode;
      console.log(`⚠️ [${adminId}] Connection closed. Reason code: ${statusCode} | Message: ${error?.message || 'Unknown'}`);

      if (s.intentionallyPaused) {
        console.log(`⏸️ [${adminId}] QR loop paused. Waiting for UI to wake it up again.`);
        s.currentSocket = null;
        return;
      }

      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      const isConflict = statusCode === DisconnectReason.replaced || statusCode === 409;
      const shouldReconnect = !isLoggedOut;

      emitToAdmin(adminId, 'whatsapp:status', { status: 'disconnected' });

      s.currentSocket = null;

      if (shouldReconnect) {
        const retryDelay = isConflict ? 5000 : 2000;

        // Preserve whichever method/number was in flight so a pairing session
        // survives Baileys' internal "restart required" reconnects instead of
        // silently falling back to QR mid-flow.
        const resumeMethod = s.connectionMethod;
        const resumePhone = s.pendingPhoneNumber;

        clearReconnectTimer(s);
        s.reconnectTimer = setTimeout(() => {
          s.reconnectTimer = null;
          if (myGeneration === s.socketGeneration && !s.currentSocket) {
            initWhatsApp(adminId, { method: resumeMethod, phoneNumber: resumePhone });
          }
        }, retryDelay);
      } else {
        console.log(`❌ [${adminId}] Logged out. Waiting for unpair payload to reach Meta...`);

        setTimeout(async () => {
          try {
            await fs.rm(getAuthDir(adminId), { recursive: true, force: true });
            console.log(`🗑️ [${adminId}] Auth folder successfully deleted.`);
          } catch (err) {
            console.error("Error deleting folder:", err);
          }

          // A logout always resets us back to the default QR flow
          s.connectionMethod = 'qr';
          s.pendingPhoneNumber = null;

          clearReconnectTimer(s);
          s.reconnectTimer = setTimeout(() => {
            s.reconnectTimer = null;
            if (myGeneration === s.socketGeneration && !s.currentSocket) {
              initWhatsApp(adminId);
            }
          }, 1000);
        }, 5000);
      }
    } else if (connection === 'open') {
      resetQRTiming(s);
      console.log(`✅ [${adminId}] WhatsApp connection opened successfully!`);

      const rawJid = sock.user?.id;
      const phone = rawJid ? rawJid.split(':')[0] : 'Unknown Number';
      const cleanJid = rawJid ? `${rawJid.split(':')[0]}@s.whatsapp.net` : null;

      const name = sock.user?.name || sock.user?.notify || sock.authState?.creds?.me?.name || 'WhatsApp Account';

      let imageUrl = null;
      if (cleanJid) {
        try {
          imageUrl = await sock.profilePictureUrl(cleanJid, 'image');
        } catch (error) {
          // Ignore missing profile pic errors
        }
      }

      s.connectedUserMeta = { phone, name, imageUrl };

      emitToAdmin(adminId, 'whatsapp:status', { status: 'connected', user: s.connectedUserMeta });
    }
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();

    if (myGeneration !== s.socketGeneration) return;

    if (s.connectedUserMeta) {
      const freshName = sock.user?.name || sock.user?.notify || sock.authState?.creds?.me?.name;
      if (freshName && freshName !== s.connectedUserMeta.name) {
        s.connectedUserMeta = { ...s.connectedUserMeta, name: freshName };
        emitToAdmin(adminId, 'whatsapp:status', { status: 'connected', user: s.connectedUserMeta });
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    if (myGeneration !== s.socketGeneration) return;
    for (const m of messages) {
      if (m.message?.pollUpdateMessage) console.log('🗳️ vote received for poll', m.message.pollUpdateMessage.pollCreationMessageKey?.id);
      saveWhatsAppMessage(adminId, m, emitToAdmin, sock).catch((e) => console.error('save msg:', e.message));
    }
  });

  sock.ev.on('messages.update', (updates) => {
    if (myGeneration !== s.socketGeneration) return;
    updateWhatsAppStatus(adminId, updates, emitToAdmin).catch(() => {});
  });

  s.currentSocket = sock;
  s.isStarting = false;
};

// Dedicated entry point the route calls for pairing-code linking.
// Tears down any idle QR-mode socket first, then restarts in pairing mode.
export const startPairingConnection = async (adminId, phoneNumber) => {
  if (!adminId) {
    throw new Error('adminId is required');
  }
  if (!phoneNumber) {
    throw new Error('phoneNumber is required');
  }

  const s = getSession(adminId);

  if (s.currentSocket && !s.connectedUserMeta) {
    s.socketGeneration++;
    clearReconnectTimer(s);
    s.currentSocket.end(undefined);
    s.currentSocket = null;
    s.isStarting = false;
  }

  // Half-finished creds from an earlier QR attempt make Meta reject the pair.
  // Safe here — we only reach this path when nobody is logged in.
  try {
    await fs.rm(getAuthDir(adminId), { recursive: true, force: true });
    console.log(`🗑️ [${adminId}] Cleared auth folder for a fresh pairing attempt.`);
  } catch { /* folder may not exist */ }

  await new Promise(r => setTimeout(r, 500));

  resetQRTiming(s);
  await initWhatsApp(adminId, { method: 'pairing', phoneNumber });
};

export const getWhatsAppConnectionState = (adminId) => {
  const s = getSession(adminId);

  if (!s.currentSocket && !s.isStarting) return { status: 'loading' };

  if (s.currentSocket?.user || s.connectedUserMeta) {
    return {
      status: 'connected',
      user: s.connectedUserMeta || {
        phone: s.currentSocket?.user?.id?.split(':')[0] || '',
        name: s.currentSocket?.user?.name || 'WhatsApp Account',
        imageUrl: null
      }
    };
  }

  // Report pairing state so a page refresh mid-pairing still shows the code
  if (s.connectionMethod === 'pairing' && s.latestPairingCode) {
    return {
      status: 'pairing',
      pairingCode: s.latestPairingCode,
      generatedAt: s.pairingCodeGeneratedAt,
      phoneNumber: s.pendingPhoneNumber,
    };
  }

  if (s.latestQR) {
    return {
      status: 'scanning',
      qrString: s.latestQR,
      generatedAt: s.latestQRGeneratedAt,
      // Reuse the interval assigned when this QR was generated rather than
      // recomputing — `latestQR` is already set by now, so re-deriving
      // "first vs subsequent" would always incorrectly say "subsequent".
      refreshInterval: s.latestQRRefreshInterval,
    };
  }

  return { status: 'loading' };
};

export const getWhatsAppSocket = (adminId) => sessions.get(adminId)?.currentSocket ?? null;

export const hasLinkedSession = async (adminId) => {
  try {
    const raw = await fs.readFile(path.join(getAuthDir(adminId), 'creds.json'), 'utf8');
    return !!JSON.parse(raw).me; // `me` only exists after a successful pair
  } catch {
    return false;
  }
};

export const logoutWhatsApp = async (adminId) => {
  const s = sessions.get(adminId);
  if (!s || !s.currentSocket) {
    return { success: true };
  }
  try {
    s.intentionallyPaused = false;
    console.log(`🔄 [${adminId}] Sending explicit unpair command to Meta...`);

    if (s.currentSocket.user?.id) {
      try {
        await s.currentSocket.query({
          tag: 'iq',
          attrs: {
            to: '@s.whatsapp.net',
            type: 'set',
            xmlns: 'md'
          },
          content: [
            {
              tag: 'remove-companion-device',
              attrs: {
                jid: s.currentSocket.user.id,
                reason: 'user_initiated'
              }
            }
          ]
        });
        console.log(`✅ [${adminId}] Meta successfully acknowledged unpair command!`);
      } catch (iqErr) {
        // Meta instantly drops the TCP connection the millisecond they unpair the
        // device. A "Connection Closed" error here means it worked perfectly.
        console.log(`✅ [${adminId}] Unpair command sent (Connection dropped intentionally by Meta).`);
      }
    }

    await s.currentSocket.logout().catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 2000));

    return { success: true };
  } catch (err) {
    console.error("Logout failed:", err);
    return { success: false, error: err.message };
  }
};

export const stopWhatsAppIdle = (adminId) => {
  const s = sessions.get(adminId);
  if (s && s.currentSocket && !s.connectedUserMeta) {
    clearReconnectTimer(s);
    s.intentionallyPaused = true;
    s.socketGeneration++;
    s.currentSocket.end(undefined);
    s.currentSocket = null;
    resetQRTiming(s); // 👈 NEW: Clears dead QRs from memory
    console.log(`🛑 [${adminId}] Admin left page. Stopping QR generation to save resources.`);
  }
};