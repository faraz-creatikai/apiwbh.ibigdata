// socket/socket.js
import { ALLOWED_ORIGINS } from "../config/cors-origins.js";
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

  io.on("connection", (socket) => {
    const adminId = socket.handshake.auth?.adminId;
    if (adminId) {
      socket.join(`admin:${adminId}`);
    }

    // ─── WHATSAPP VIEWER TRACKING ──────────────────────────────────────

    // 1. User opens the QR page
    socket.on("whatsapp:start_viewing", () => {
      socket.join("whatsapp_qr_viewers");

      const viewerCount = io.sockets.adapter.rooms.get("whatsapp_qr_viewers")?.size || 0;
      console.log(`👀 WhatsApp QR Viewer joined. Total viewing: ${viewerCount}`);

      // If this is the FIRST person to open the page, wake up the engine
      // in default QR mode. Pairing mode is only ever started explicitly
      // via the /whatsapp-connection-pairing-code route, never here.
      if (viewerCount === 1) {
        const state = getWhatsAppConnectionState();
        if (state.status === 'loading') {
          console.log("🚦 Waking up WhatsApp engine via Socket...");
          initWhatsApp();
        }
      }
    });

    // 2. User clicks the back button or navigates away
    socket.on("whatsapp:stop_viewing", () => {
      socket.leave("whatsapp_qr_viewers");
      checkViewersAndStop();
    });

    // 3. User closes the browser completely (Socket drops)
    socket.on("disconnect", () => {
      // The socket automatically leaves all rooms on disconnect,
      // we just need to check if the room is now empty.
      checkViewersAndStop();
    });

    // Helper to kill the engine if the room is empty
    function checkViewersAndStop() {
      const viewerCount = io.sockets.adapter.rooms.get("whatsapp_qr_viewers")?.size || 0;
      if (viewerCount === 0) {
        stopWhatsAppIdle(); // This function already checks if it's safe to stop (i.e. not logged in)
      } else {
        console.log(`👀 User left, but ${viewerCount} admin(s) are still viewing.`);
      }
    }
  });

  return io;
};

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

export const getSocket = () => io ?? null;