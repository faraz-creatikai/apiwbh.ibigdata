import express from "express";
import { protectRoute } from "../middlewares/auth.js";
import { disconnectFacebook, disconnectInstagram, getFacebookAnalytics, getFacebookLivePosts, getInstagramAnalytics, getInstagramLivePosts, getScheduledPosts, metaCallback, runAutoSocialAgent, scheduleFacebookPost, scheduleInstagramPost } from "../controllers/controller.socialAuth.js";
import upload from "../config/multer.js";

const socialAuthRoutes = express.Router();

//socialAuthRoutes.use(protectRoute);




//saving mined leads 

socialAuthRoutes.get("/meta-callback", metaCallback);


//insta
socialAuthRoutes.get("/get-instagram-posts",protectRoute, getInstagramLivePosts);
socialAuthRoutes.get("/get-instagram-analytics", protectRoute, getInstagramAnalytics);
socialAuthRoutes.delete("/disconnect-instagram", protectRoute, disconnectInstagram);

socialAuthRoutes.post("/schedule-instagram-post",protectRoute, upload.fields([
    { name: "PostImage", maxCount: 5 },
]), scheduleInstagramPost)

socialAuthRoutes.get("/scheduled-posts-data", protectRoute, getScheduledPosts);


//facebook
socialAuthRoutes.get("/get-facebook-posts", protectRoute, getFacebookLivePosts);
socialAuthRoutes.get("/get-facebook-analytics", protectRoute, getFacebookAnalytics);
socialAuthRoutes.delete("/disconnect-facebook", protectRoute, disconnectFacebook);
socialAuthRoutes.post("/schedule-facebook-post", protectRoute, upload.fields([
    { name: "PostImage", maxCount: 5 },
]), scheduleFacebookPost)


socialAuthRoutes.post("/auto-social-agent", protectRoute, upload.fields([
    { name: "PostImage", maxCount: 5 },
]), runAutoSocialAgent);

export default socialAuthRoutes;