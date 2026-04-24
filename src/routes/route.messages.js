import express from "express";
import {
  callCustomer,
  sendEmailByTemplate,
  sendWhatsAppByTemplate,
  sendWhatsAppMessage,
} from "../controllers/controller.messages.js";

const messageRoutes = express.Router();

messageRoutes.post("/email", sendEmailByTemplate);
messageRoutes.post("/whatsapp", sendWhatsAppByTemplate);

messageRoutes.post("/call",callCustomer);

messageRoutes.all("/exotel/voice", (req, res) => {
  res.set("Content-Type", "text/xml");

  res.send(`
<Response>
<Say voice="women" language="en-IN">Hello, this is Adarsh from Creatikai Solutions. I am calling to understand your requirements.</Say>
</Response>
  `);
});

export default messageRoutes;
