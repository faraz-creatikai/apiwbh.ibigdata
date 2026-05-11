import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);


//twilio api
export const sendWhatsApp = async (to, message, imageUrl = null) => {
  try {
    const payload = {
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${to}`,
      body: message,
    };

    // ✅ Add media if exists
    if (imageUrl) {
      payload.mediaUrl = [imageUrl]; // must be array
    }

    const result = await client.messages.create(payload);

    console.log("WhatsApp sent:", result.sid);
    return result;
  } catch (error) {
    console.error("WhatsApp error:", error.message);
    throw error;
  }
};


//digitalsms api
/* export const sendWhatsApp = async (to, message, imageUrl = null) => {
  try {
    // 👉 remove "+" if present
    const mobile = to.replace("+", "");

    // 👉 append image URL if exists
    let finalMessage = message;
    if (imageUrl) {
      finalMessage += ` ${imageUrl}`;
    }

    // 👉 build query params safely
    const params = new URLSearchParams({
      apikey: process.env.DIGITALSMS,
      mobile: mobile,
      msg: finalMessage,
    });

    const url = `https://demo.digitalsms.biz/api/?${params.toString()}`;

    const response = await fetch(url, {
      method: "GET",
    });

    const data = await response.json(); // or .text() if their API is not JSON

    console.log("WhatsApp sent:", data);

    return {
      sid: data?.message_id || "no-id",
      raw: data,
    };
  } catch (error) {
    console.error("WhatsApp error:", error.message);
    throw error;
  }
}; */


//meta facebook api
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
