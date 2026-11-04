import express from "express";
import { protectRoute } from "../middlewares/auth.js";
import { disconnectFacebook, disconnectInstagram, getFacebookAnalytics, getFacebookLivePosts, getInstagramAnalytics, getInstagramLivePosts, getScheduledPosts, metaCallback, runAutoSocialAgent, scheduleFacebookPost, scheduleInstagramPost} from "../controllers/controller.socialAuth.js";
import upload from "../config/multer.js";
import { checkWhatsAppConnection, connectMetaWhatsapp, disconnectMetaWhatsapp, getMetaChatHistory, getMetaInboxSummary, getMetaTemplates, markMetaChatRead, receiveWhatsAppMessage, sendMetaTemplateMessage, sendMetaWhatsAppMessage, verifyMetaTemplate, verifyWhatsAppWebhook } from "../controllers/controller.whatsappMeta.js";
import { createCampaign, deleteCampaign, getCampaigns, startCampaign } from "../controllers/controller.whatsappCampaign.js";

const socialAuthRoutes = express.Router();


socialAuthRoutes.get("/whatsapp-webhook", verifyWhatsAppWebhook);
socialAuthRoutes.post("/whatsapp-webhook", receiveWhatsAppMessage);

socialAuthRoutes.use(protectRoute);




//saving mined leads 

socialAuthRoutes.get("/meta-callback", metaCallback);


//insta
socialAuthRoutes.get("/get-instagram-posts", getInstagramLivePosts);
socialAuthRoutes.get("/get-instagram-analytics", getInstagramAnalytics);
socialAuthRoutes.delete("/disconnect-instagram", disconnectInstagram);

socialAuthRoutes.post("/schedule-instagram-post", upload.fields([
    { name: "PostImage", maxCount: 5 },
]), scheduleInstagramPost)

socialAuthRoutes.get("/scheduled-posts-data", getScheduledPosts);


//facebook
socialAuthRoutes.get("/get-facebook-posts", getFacebookLivePosts);
socialAuthRoutes.get("/get-facebook-analytics", getFacebookAnalytics);
socialAuthRoutes.delete("/disconnect-facebook", disconnectFacebook);
socialAuthRoutes.post("/schedule-facebook-post", upload.fields([
    { name: "PostImage", maxCount: 5 },
]), scheduleFacebookPost)


socialAuthRoutes.post("/auto-social-agent", upload.fields([
    { name: "PostImage", maxCount: 5 },
]), runAutoSocialAgent);


socialAuthRoutes.post("/connect-meta-whatsapp", connectMetaWhatsapp);
socialAuthRoutes.delete('/disconnect-meta-whatsapp', disconnectMetaWhatsapp)
socialAuthRoutes.get('/check-meta-whatsapp', checkWhatsAppConnection);
socialAuthRoutes.post("/send-meta-message", sendMetaWhatsAppMessage);

socialAuthRoutes.get("/meta-inbox/summary", getMetaInboxSummary);
socialAuthRoutes.get("/meta-inbox/chat/:phoneKey", getMetaChatHistory);
socialAuthRoutes.post("/meta-inbox/chat/:phoneKey/read", markMetaChatRead);

//template of meta whastapp
socialAuthRoutes.get("/meta-templates",getMetaTemplates);
socialAuthRoutes.post("/verify-meta-template",verifyMetaTemplate);


//whatsapp campaign

socialAuthRoutes.post("/meta-campaigns", createCampaign);
socialAuthRoutes.get("/meta-campaigns", getCampaigns);
socialAuthRoutes.post("/meta-campaigns/:campaignId/start", startCampaign);
socialAuthRoutes.delete("/meta-campaigns/:campaignId", deleteCampaign);
socialAuthRoutes.post("/send-meta-template",sendMetaTemplateMessage);


export default socialAuthRoutes;