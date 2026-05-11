import { ALLOWED_ORIGINS } from "../config/cors-origins.js";

// socket.js
let io;

export const initSocket = async (server) => {
  const { Server } = await import("socket.io");
  io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket"],   // ← add this line
  pingInterval: 25000,
  pingTimeout: 20000,
});

  io.on("connection", (socket) => {
    const adminId = socket.handshake.auth?.adminId;
    if (adminId) {
      socket.join(`admin:${adminId}`);
    //  console.log(`Admin ${adminId} connected`);
    }

    socket.on("disconnect", () => {
    //  console.log(`Admin ${adminId} disconnected`);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

export const getSocket = () => io ?? null;