import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export const sendWhatsApp = async (to, message) => {
  try {
    const result = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${to}`,
      body: message,
    });
    console.log("WhatsApp sent:", result.sid);
    return result;
  } catch (error) {
    console.error("WhatsApp error:", error.message);
    throw error;
  }
};

// export const sendWhatsApp = async (to, message) => {
//   try {
//     // Format phone (remove '+' if present)
//     const phone = to.replace("+", "").trim();

//     const response = await axios.post(
//       `https://graph.facebook.com/v19.0/${process.env.META_WA_PHONE_ID}/messages`,
//       {
//         messaging_product: "whatsapp",
//         to: phone,
//         type: "text",
//         text: { body: message },
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.META_WA_ACCESS_TOKEN}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     console.log("✅ WhatsApp sent:", response.data.messages?.[0]?.id || "Message Sent");
//     return response.data;
//   } catch (error) {
//     const errMsg = error.response?.data?.error?.message || error.message;
//     console.error("❌ WhatsApp error:", errMsg);
//     throw new Error(errMsg);
//   }
// };
