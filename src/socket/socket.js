// socket/socket.js
import { ALLOWED_ORIGINS } from "../config/cors-origins.js";
import { registerPresence, startPresenceHeartbeat, closeStaleSessions } from "./presence.js";
// 👇 Import the WhatsApp controllers
import { initWhatsApp, stopWhatsAppIdle, getWhatsAppConnectionState } from "../config/baileys.js";

let io;

export const initSocket = async (server) => {
  const { Server } = await import("socket.io");
  io = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket"],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // clean sessions left open by a restart and start heartbeat
  await closeStaleSessions();   
  startPresenceHeartbeat();

  io.on("connection", (socket) => {
    const adminId = socket.handshake.auth?.adminId;
    console.log("🔌 admin socket connected", { adminId });
    
    if (adminId) {
      socket.join(`admin:${adminId}`);
    }

    registerPresence(io, socket);

    // ─── WHATSAPP VIEWER TRACKING (per admin) ───
    const waRoom = `whatsapp_qr_viewers:${adminId}`;

    socket.on("whatsapp:start_viewing", (ack) => {
      console.log("🔎 whatsapp:start_viewing", { adminId });
      if (!adminId) return;
      socket.join(waRoom);

      const state = getWhatsAppConnectionState(adminId);
      console.log("🚦 WhatsApp state at start_viewing:", { adminId, status: state.status });
      
      if (state.status === 'loading') {
        initWhatsApp(adminId).catch((err) =>
          console.error(`❌ [${adminId}] initWhatsApp failed:`, err.message)
        );
      } else if (state.status === 'connected') {
        // 👈 NEW: Push the connected state immediately to unfreeze UI
        socket.emit("whatsapp:status", { status: 'connected', user: state.user });
      } else if (state.status === 'scanning') {
        // 👈 NEW: Push the live QR immediately to unfreeze UI
        socket.emit("whatsapp:qr", { qrString: state.qrString, generatedAt: state.generatedAt, refreshInterval: state.refreshInterval });
      } else if (state.status === 'pairing') {
        // 👈 NEW: Push the pairing code immediately to unfreeze UI
        socket.emit("whatsapp:pairing_code", { code: state.pairingCode, generatedAt: state.generatedAt });
      }

      if (typeof ack === "function") ack({ status: state.status });
    });

    socket.on("whatsapp:stop_viewing", () => {
      socket.leave(waRoom);
      checkViewersAndStop();
    });

    socket.on("disconnect", () => {
      checkViewersAndStop();
    });

    function checkViewersAndStop() {
      if (!adminId) return;
      const viewerCount = io.sockets.adapter.rooms.get(waRoom)?.size || 0;
      if (viewerCount === 0) stopWhatsAppIdle(adminId);
    }
  });

  return io;
};

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

export const getSocket = () => io ?? null;