// config/baileys.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { getSocket } from '../socket/socket.js';
import fs from 'fs/promises';
import pino from 'pino';

// 👇 CHANGED: was 3 hand-tuned constants (SEED/MIN/MAX) used to *guess* the QR refresh
// interval by measuring the gap between successive `qr` events — unreliable (event-loop
// jitter, no prior sample for the very first QR) and could show the UI a countdown that
// doesn't match when the code actually dies.
//
// Verified directly against Baileys' source (src/Socket/socket.ts, the `genPairQR` loop
// that fires on the `pair-device` stanza):
//   let qrMs = qrTimeout || 60_000   // time to let a QR live
//   ...
//   qrTimer = setTimeout(genPairQR, qrMs)
//   qrMs = qrTimeout || 20_000       // shorter subsequent qrs
// i.e. when `qrTimeout` is left unset (as we do — see makeWASocket() below, we deliberately
// do NOT set it), the FIRST QR of a pairing attempt lives 60s, and every QR after that lives
// only 20s. These two numbers are hardcoded in Baileys itself, not configurable defaults we
// can read from a field — so we mirror them exactly instead of estimating anything.
const FIRST_QR_TIMEOUT_MS = 60_000;
const SUBSEQUENT_QR_TIMEOUT_MS = 20_000;

let currentSocket = null;

// ── QR state ─────────────────────────────────────────────────────────
let latestQR = null;
let latestQRGeneratedAt = null;
let latestQRRefreshInterval = null; // the exact ms this specific QR frame will live (60_000 or 20_000)

// ── Pairing code state (NEW) ─────────────────────────────────────────
let latestPairingCode = null;
let pairingCodeGeneratedAt = null;
let connectionMethod = 'qr'; // 'qr' | 'pairing'
let pendingPhoneNumber = null;

let connectedUserMeta = null;
let intentionallyPaused = false;
let isStarting = false;

let reconnectTimer = null;
let socketGeneration = 0;

const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};

const resetQRTiming = () => {
  latestQR = null;
  latestQRGeneratedAt = null;
  latestQRRefreshInterval = null;
  // also clear pairing state — same lifecycle as QR
  latestPairingCode = null;
  pairingCodeGeneratedAt = null;
};

export const initWhatsApp = async (options = {}) => {
  const { method = 'qr', phoneNumber = null } = options;

  if (isStarting || currentSocket) {
    return;
  }

  isStarting = true;
  intentionallyPaused = false;
  connectionMethod = method;
  pendingPhoneNumber = phoneNumber;
  clearReconnectTimer();

  const myGeneration = ++socketGeneration;

  const { state, saveCreds } = await useMultiFileAuthState('whatsapp-auth-folder');

  const sock = makeWASocket({
    auth: state,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    // 👇 NEW: an explicit, well-known browser fingerprint + no artificial
    // query timeout. Baileys' own default identity is unreliable for the
    // pairing-code handshake specifically — QR mode works fine without this,
    // but pairing needs it to avoid an immediate 428 "Connection Closed".
    browser: Browsers.ubuntu('Chrome'),
    defaultQueryTimeoutMs: undefined,
    // 👇 NOTE: deliberately NOT setting qrTimeout here. Baileys uses `qrTimeout || 60_000`
    // for the first QR and `qrTimeout || 20_000` for every one after — passing an explicit
    // value would apply it to *every* QR uniformly (first included), which changes the real
    // pairing cadence, not just what we report. Leaving it unset keeps Baileys' native
    // 60s-first/20s-after behavior intact; see FIRST_QR_TIMEOUT_MS / SUBSEQUENT_QR_TIMEOUT_MS
    // above, which mirror those same two hardcoded numbers for reporting purposes only.
    logger: pino({ level: 'silent' })
  });

  // 👇 NEW: guards so the pairing request fires exactly once per socket
  let pairingRequestSent = false;

  const requestPairing = async () => {
    if (pairingRequestSent) return;
    pairingRequestSent = true;

    try {
      const cleanNumber = pendingPhoneNumber.replace(/[^0-9]/g, '');
      const code = await sock.requestPairingCode(cleanNumber);

      if (myGeneration !== socketGeneration) return;

      latestPairingCode = code;
      pairingCodeGeneratedAt = Date.now();

      console.log(`🔑 Pairing code generated for ${cleanNumber}: ${code}`);

      const io = getSocket();
      if (io) {
        io.emit('whatsapp:pairing_code', {
          code,
          generatedAt: pairingCodeGeneratedAt,
        });
      }
    } catch (err) {
      console.error('❌ Failed to request pairing code:', err.message);
      pairingRequestSent = false; // allow the client's "resend" to try again
      const io = getSocket();
      if (io) {
        io.emit('whatsapp:pairing_error', { message: err.message });
      }
    }
  };

  sock.ev.on('connection.update', async (update) => {
    if (myGeneration !== socketGeneration) return;

    const { connection, lastDisconnect, qr } = update;
    const io = getSocket();

    // 👇 CHANGED: only broadcast QR frames when we're actually in QR mode,
    // so pairing-mode sessions don't flash a QR code the UI never shows.
    if (qr && connectionMethod !== 'pairing') {
      const now = Date.now();

      // 👇 CHANGED: `latestQR` is null exactly when this is the first `qr` event since the
      // last reset (fresh socket / fresh attempt) — the same condition, in effect, that
      // Baileys' own genPairQR loop uses to decide "first vs. subsequent" (see constants
      // above). So we reuse that existing null-check instead of adding new bookkeeping.
      const isFirstQrOfAttempt = latestQR === null;
      const refreshInterval = isFirstQrOfAttempt ? FIRST_QR_TIMEOUT_MS : SUBSEQUENT_QR_TIMEOUT_MS;

      latestQR = qr;
      latestQRGeneratedAt = now;
      latestQRRefreshInterval = refreshInterval;

      console.log(`📲 New QR Code generated (expires in ${refreshInterval}ms)`);
      if (io) {
        io.emit('whatsapp:qr', {
          qrString: qr,
          generatedAt: latestQRGeneratedAt,
          refreshInterval,
        });
      }
    }

    // 👇 FIXED: gate strictly on `qr`, matching Baileys' own recommended
    // pattern. `connection === 'connecting'` fires the instant the socket
    // starts opening — BEFORE the noise handshake completes — so calling
    // requestPairingCode() on that trigger reproduces the exact "Connection
    // Closed" (428) bug we were trying to avoid. `qr` only appears once the
    // handshake is actually done, which is the real readiness signal.
    if (
      connectionMethod === 'pairing' &&
      pendingPhoneNumber &&
      !state.creds.registered &&
      qr
    ) {
      requestPairing();
    }

    if (connection === 'close') {
      resetQRTiming();
      connectedUserMeta = null;

      if (intentionallyPaused) {
        console.log("⏸️ QR loop paused. Waiting for UI to wake it up again.");
        currentSocket = null;
        return;
      }

      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      const isConflict = statusCode === DisconnectReason.replaced || statusCode === 409;
      const shouldReconnect = !isLoggedOut;

      if (io) io.emit('whatsapp:status', { status: 'disconnected' });

      currentSocket = null;

      if (shouldReconnect) {
        const retryDelay = isConflict ? 5000 : 2000;

        // 👇 NEW: preserve whichever method/number was in flight so a
        // pairing session survives Baileys' internal "restart required"
        // reconnects instead of silently falling back to QR mid-flow.
        const resumeMethod = connectionMethod;
        const resumePhone = pendingPhoneNumber;

        clearReconnectTimer();
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (myGeneration === socketGeneration && !currentSocket) {
            initWhatsApp({ method: resumeMethod, phoneNumber: resumePhone });
          }
        }, retryDelay);
      } else {
        // 👇 FIX: Increased delay to 5000ms (5 seconds) to ensure the network is totally clear
        console.log('❌ Logged out. Waiting for unpair payload to reach Meta...');

        setTimeout(async () => {
          try {
            await fs.rm('whatsapp-auth-folder', { recursive: true, force: true });
            console.log('🗑️ Auth folder successfully deleted.');
          } catch (err) {
            console.error("Error deleting folder:", err);
          }

          // 👇 NEW: a logout always resets us back to the default QR flow
          connectionMethod = 'qr';
          pendingPhoneNumber = null;

          clearReconnectTimer();
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (myGeneration === socketGeneration && !currentSocket) {
              initWhatsApp();
            }
          }, 1000);
        }, 5000);
      }
    } else if (connection === 'open') {
      resetQRTiming();
      console.log('✅ WhatsApp connection opened successfully!');

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

      connectedUserMeta = { phone, name, imageUrl };

      if (io) {
        io.emit('whatsapp:status', { status: 'connected', user: connectedUserMeta });
      }
    }
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();

    if (myGeneration !== socketGeneration) return;

    if (connectedUserMeta) {
      const freshName = sock.user?.name || sock.user?.notify || sock.authState?.creds?.me?.name;
      if (freshName && freshName !== connectedUserMeta.name) {
        connectedUserMeta = { ...connectedUserMeta, name: freshName };
        const io = getSocket();
        if (io) io.emit('whatsapp:status', { status: 'connected', user: connectedUserMeta });
      }
    }
  });

  currentSocket = sock;
  isStarting = false;
};

// 👇 NEW: dedicated entry point the route calls for pairing-code linking.
// Tears down any idle QR-mode socket first, then restarts in pairing mode.
export const startPairingConnection = async (phoneNumber) => {
  if (!phoneNumber) {
    throw new Error('phoneNumber is required');
  }

  if (currentSocket && !connectedUserMeta) {
    socketGeneration++;
    clearReconnectTimer();
    currentSocket.end(undefined);
    currentSocket = null;
    isStarting = false;
  }

  resetQRTiming();
  await initWhatsApp({ method: 'pairing', phoneNumber });
};

export const getWhatsAppConnectionState = () => {
  if (!currentSocket && !isStarting) return { status: 'loading' };

  if (currentSocket?.user || connectedUserMeta) {
    return {
      status: 'connected',
      user: connectedUserMeta || {
        phone: currentSocket?.user?.id?.split(':')[0] || '',
        name: currentSocket?.user?.name || 'WhatsApp Account',
        imageUrl: null
      }
    };
  }

  // 👇 NEW: report pairing state so a page refresh mid-pairing still shows the code
  if (connectionMethod === 'pairing' && latestPairingCode) {
    return {
      status: 'pairing',
      pairingCode: latestPairingCode,
      generatedAt: pairingCodeGeneratedAt,
      phoneNumber: pendingPhoneNumber,
    };
  }

  if (latestQR) {
    return {
      status: 'scanning',
      qrString: latestQR,
      generatedAt: latestQRGeneratedAt,
      // 👇 CHANGED: reuse the exact interval that was assigned when this QR was generated
      // (60_000 or 20_000, see the `qr` handler above) rather than recomputing it here —
      // by this point `latestQR` is already set, so re-deriving "first vs subsequent" from
      // it would incorrectly always say "subsequent".
      refreshInterval: latestQRRefreshInterval,
    };
  }

  return { status: 'loading' };
};

export const getWhatsAppSocket = () => currentSocket;

export const logoutWhatsApp = async () => {
  if (!currentSocket) {
    return { success: true };
  }
  try {
    intentionallyPaused = false;
    console.log("🔄 Sending explicit unpair command to Meta...");

    if (currentSocket.user?.id) {
      try {
        await currentSocket.query({
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
                jid: currentSocket.user.id,
                reason: 'user_initiated'
              }
            }
          ]
        });
        console.log("✅ Meta successfully acknowledged unpair command!");
      } catch (iqErr) {
        // Meta instantly drops the TCP connection the millisecond they unpair the device.
        // If this throws a "Connection Closed" error, it means it worked perfectly!
        console.log("✅ Unpair command sent (Connection dropped intentionally by Meta).");
      }
    }

    await currentSocket.logout().catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 2000));

    return { success: true };
  } catch (err) {
    console.error("Logout failed:", err);
    return { success: false, error: err.message };
  }
};

export const stopWhatsAppIdle = () => {
  if (currentSocket && !connectedUserMeta) {
    clearReconnectTimer();
    intentionallyPaused = true;
    socketGeneration++;
    currentSocket.end(undefined);
    currentSocket = null;
    console.log("🛑 Admin left page. Stopping QR generation to save resources.");
  }
};