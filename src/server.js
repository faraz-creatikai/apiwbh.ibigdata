import dotenv from "dotenv";
dotenv.config();

import app from "./app.js";
import { syncCallLogsInternal } from "./jobs/syncCallLogs.js";

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  setInterval(async () => {
    try {
     // console.log("🔄 Syncing call logs...");
      await syncCallLogsInternal();
    } catch (err) {
      console.error("❌ Sync error:", err);
    }
  }, 10000);
});

