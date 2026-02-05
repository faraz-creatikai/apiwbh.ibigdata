import express from "express";
import {
  sendEmailByTemplate,
  sendWhatsAppByTemplate,
} from "../controllers/controller.messages.js";

const messageRoutes = express.Router();

messageRoutes.post("/email", sendEmailByTemplate);
messageRoutes.post("/whatsapp", sendWhatsAppByTemplate);

export default messageRoutes;
