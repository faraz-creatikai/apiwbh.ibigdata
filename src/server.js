import dotenv from "dotenv";
dotenv.config();

import { createServer } from "http";
import app from "./app.js";

import { startCallLogSync, syncCallLogsInternal } from "./jobs/syncCallLogs.js";
import { initFacebookCron, initInstagramCron } from "./jobs/instagramScheduler.js";
import { initSocket } from "./socket/socket.js";
import { deleteOldNotifications, initFollowupNotificationCron } from "./jobs/notification/notificationEvents.js";


const PORT = process.env.PORT || 5000;

// wrap app in an HTTP server, then hand it to socket.io
const server = createServer(app);
initSocket(server);

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  startCallLogSync(); // ← replaces the entire setInterval block

  initInstagramCron();
  initFacebookCron();
  initFollowupNotificationCron();

  setInterval(async () => {
    try { await deleteOldNotifications(); }
    catch (err) { console.error("Notification cleanup error:", err); }
  }, 24 * 60 * 60 * 1000);
});