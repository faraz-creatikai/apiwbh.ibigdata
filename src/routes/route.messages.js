import express from "express";
import {
  callCustomer,
  sendBaileysWhatsAppByTemplate,
  sendBaileysWhatsAppProperties,
  sendDirectWhatsAppMessage,
  sendEmailByTemplate,
  sendEmailDirectToCustomers,
  sendWhatsAppByTemplate,
  sendWhatsAppMessage,
} from "../controllers/controller.messages.js";
import { getWhatsAppConnectionState, getWhatsAppSocket, initWhatsApp, logoutWhatsApp, startPairingConnection, stopWhatsAppIdle } from "../config/baileys.js";
import upload, { templateUpload } from "../config/multer.js";
import cloudinary from "../config/cloudinary.js";
import fs from "fs"
import { protectRoute } from "../middlewares/auth.js";
import { deleteChat, getChatMessages, getInboxSummary, markChatRead } from "../controllers/controller.whatsappInbox.js";
import { connectEmail, disconnectEmail, getEmailConnection, testEmailConnection, verifyEmailConnection } from "../controllers/controller.emailconnection.js";
import { sendTestEmail } from "../controllers/controller.emailconnection.js";
import { downloadEmailAttachment, getEmailInboxStatus, getEmailMessage, listEmailMessages, syncEmailInbox, updateEmailMessages } from "../controllers/controller.emailInbox.js";
import { cancelEmailSendBatch, getEmailSendBatch, replyToInboxEmail, sendEmailFromInbox } from "../controllers/controller.emailCompose.js";

const messageRoutes = express.Router();
messageRoutes.use(protectRoute);


//email routes

messageRoutes.post("/email", sendEmailByTemplate);
messageRoutes.get("/email-connection", getEmailConnection);
messageRoutes.post("/email-connection/test", testEmailConnection);
messageRoutes.post("/email-connection", connectEmail);
messageRoutes.post("/email-connection/verify", verifyEmailConnection);
messageRoutes.delete("/email-connection", disconnectEmail);
messageRoutes.post("/email-connection/send-test",sendTestEmail);




//email inbox routes
messageRoutes.get("/email/inbox/status", getEmailInboxStatus);
messageRoutes.post("/email/inbox/sync", syncEmailInbox);
messageRoutes.get("/email/inbox/messages", listEmailMessages);
messageRoutes.patch("/email/inbox/messages", updateEmailMessages); // bulk: { ids, isRead?, isStarred? }
messageRoutes.get("/email/inbox/messages/:id", getEmailMessage);
messageRoutes.get("/email/inbox/messages/:id/attachments/:index", downloadEmailAttachment);

//email inbox compose send/reply routes
const emailAttach = templateUpload.fields([{ name: "attachments", maxCount: 5 }]); // files are optional
//messageRoutes.post("/email/inbox/send", emailAttach, sendEmailFromInbox);
messageRoutes.post("/email/inbox/reply", emailAttach, replyToInboxEmail);
messageRoutes.get("/email/inbox/batches/:id", getEmailSendBatch);
messageRoutes.post("/email/inbox/batches/:id/cancel", cancelEmailSendBatch);


//whatsapp routes


messageRoutes.post("/whatsapp", sendBaileysWhatsAppByTemplate);
messageRoutes.post("/whatsapp/send-properties", sendBaileysWhatsAppProperties);
messageRoutes.post("/whatsapp/direct-message", templateUpload.fields([{ name: "whatsappFile", maxCount: 5 }]), sendDirectWhatsAppMessage);

messageRoutes.get('/whatsapp/inbox/summary', getInboxSummary);
messageRoutes.get('/whatsapp/inbox/chat/:phoneKey', getChatMessages)
messageRoutes.post('/whatsapp/inbox/chat/:phoneKey/read', markChatRead);
messageRoutes.delete('/whatsapp/inbox/chat/:phoneKey', deleteChat);

messageRoutes.post("/uploads/file", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: "mail-templates",
    });

    // clean up the local temp file now that it's on Cloudinary
    fs.unlink(req.file.path, () => { });

    // GrapesJS's default asset manager expects this exact shape
    res.json({ data: [result.secure_url] });
  } catch (err) {
    console.error("Cloudinary upload failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

messageRoutes.get('/whatsapp-connection-status', (req, res) => {
  const state = getWhatsAppConnectionState(req.admin.id);
  console.log("status check for", req.admin.id, "->", state.status);
  res.json(state);
});

messageRoutes.post('/whatsapp-connection-logout', async (req, res) => {
  // Keep this! The UI button still calls it.
  const result = await logoutWhatsApp(req.admin.id);
  res.json(result);
});

messageRoutes.post('/whatsapp-connection-pairing-code', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return res.status(400).json({ success: false, error: 'phoneNumber is required' });
  }

  try {
    await startPairingConnection(req.admin.id, phoneNumber);
    res.json({ success: true, message: 'Pairing requested — code will arrive via socket' });
  } catch (err) {
    console.error('Failed to start pairing connection:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

messageRoutes.post("/send-email-via-ai", sendEmailDirectToCustomers);



messageRoutes.post("/call", callCustomer);

messageRoutes.all("/exotel/voice", (req, res) => {
  res.set("Content-Type", "text/xml");

  res.send(`
<Response>
<Say voice="women" language="en-IN">Hello, this is Adarsh from Creatikai Solutions. I am calling to understand your requirements.</Say>
</Response>
  `);
});

export default messageRoutes;
