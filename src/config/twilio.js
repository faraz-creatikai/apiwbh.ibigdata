import twilio from "twilio";
import dotenv from "dotenv";
import { getWhatsAppConnectionState, getWhatsAppSocket, hasLinkedSession, initWhatsApp } from "./baileys.js";
import { recordSend } from "../utils/channelTracking.js";

dotenv.config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);


// Add this right below your imports at the top of the file
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min));
const typingTime = (text = "") =>
  Math.min(8000, Math.max(1500, text.length * 50 + rand(0, 800)));

// ───────────────────────────────────────────────────────────────
// Per-admin throttle (ban protection)
// Every message waits until 45-90s have passed since that admin's previous one,
// plus a 3-7 minute break after every 20 messages. Calls from different places
// (campaign, templates, properties, direct) all share the same queue.
// ───────────────────────────────────────────────────────────────
const GAP_MIN_MS = 45_000;  // shortest wait between messages (45 seconds)
const GAP_MAX_MS = 90_000;  // longest wait between messages (90 seconds)
const BREAK_EVERY = 20;         // long break after this many messages
const BREAK_MIN_MS = 180_000;   // shortest break (3 min)
const BREAK_MAX_MS = 420_000;   // longest break (7 min)
const lastTurn = new Map();   // adminId -> when the last message got its turn
const sentCount = new Map();  // adminId -> messages sent so far
const queue = new Map();      // adminId -> promise chain (keeps parallel calls in order)

const waitForTurn = (adminId) => {
  const prev = queue.get(adminId) || Promise.resolve();
  const mine = prev.then(async () => {
    const wait = (lastTurn.get(adminId) || 0) + rand(GAP_MIN_MS, GAP_MAX_MS) - Date.now();
    if (wait > 0) await delay(wait);

    const n = (sentCount.get(adminId) || 0) + 1;
    sentCount.set(adminId, n);
    if (n % BREAK_EVERY === 0) await delay(rand(BREAK_MIN_MS, BREAK_MAX_MS));

    lastTurn.set(adminId, Date.now());
  });
  queue.set(adminId, mine.catch(() => { }));
  return mine;
};

//twilio api
export const sendWhatsApp = async (to, message, imageUrl = null) => {
  try {
    const payload = {
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${to}`,
      body: message,
    };

    //Add media if exists
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


// utility.js
// Import your active Baileys socket from wherever you initialize it


// helper: guess mimetype from a URL's extension (used for document sends)
const getMimeType = (url = "") => {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  const map = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    mp4: "video/mp4",
    mov: "video/quicktime",
  };
  return map[ext] || "application/octet-stream";
};

export const sendBaileysWhatsApp = async (adminId, to, message, imageUrl = null, extra = {}) => {
  try {
    let sock = getWhatsAppSocket(adminId);

    // 1. Wake up engine if asleep
    if (!sock || getWhatsAppConnectionState(adminId).status !== 'connected') {
      if (!sock) {
        if (!(await hasLinkedSession(adminId))) throw new Error("WhatsApp is not linked for this admin");
        initWhatsApp(adminId).catch((e) => console.error(`[${adminId}] init failed:`, e.message));
      }

      let retries = 0;
      while (getWhatsAppConnectionState(adminId).status !== 'connected' && retries < 15) {
        await delay(10000);
        retries++;
      }

      sock = getWhatsAppSocket(adminId);
      if (!sock || getWhatsAppConnectionState(adminId).status !== 'connected') {
        throw new Error("WhatsApp socket failed to connect. Is this admin's WhatsApp linked?");
      }
    }

    const {
      mediaType = "text",
      fileName = "",
      linkPreview = null,
      location = null,
      poll = null,
      humanize = true,
    } = extra;

    const jid = `${to}@s.whatsapp.net`;

    // 2. Only download media if the template actually requires a file
    let mediaBufferPromise = null;
    const isFileMedia = ["image", "video", "document"].includes(mediaType);

    if (imageUrl && isFileMedia) {
      mediaBufferPromise = fetch(imageUrl)
        .then(res => res.arrayBuffer())
        .then(buf => Buffer.from(buf))
        .catch(err => {
          console.warn("⚠️ Failed to pre-fetch media, falling back to URL stream:", err.message);
          return { url: imageUrl };
        });
    }

    // 3. Humanize delay
    if (humanize) {
      await waitForTurn(adminId);                       // the 45-90s gap between messages
      sock = getWhatsAppSocket(adminId) || sock;        // socket may have reconnected while waiting

      await sock.presenceSubscribe(jid).catch(() => { });
      await delay(rand(1500, 4000));

      const isRecording = mediaType === "video";
      await sock.sendPresenceUpdate(isRecording ? "recording" : "composing", jid).catch(() => { });

      await delay(isFileMedia ? rand(2000, 4000) : typingTime(message));

      await sock.sendPresenceUpdate("paused", jid).catch(() => { });
    }

    let content;

    // 4. Build Content explicitly based on our new trusted mediaType
    if (mediaType === "poll" && poll?.name) {
      content = {
        poll: {
          name: poll.name,
          values: poll.options,
          selectableCount: poll.selectableCount || 1,
        },
      };
    } else if (mediaType === "location" && location?.lat && location?.lng) {
      content = {
        location: {
          degreesLatitude: Number(location.lat),
          degreesLongitude: Number(location.lng),
          name: location.name || "",
          address: location.address || "",
        },
      };
    } else if (isFileMedia && imageUrl) {
      const mediaSource = mediaBufferPromise ? (await mediaBufferPromise) : { url: imageUrl };

      if (mediaType === "video") {
        content = { video: mediaSource, caption: message };

        // 🚀 CLOUDINARY ZERO-LOAD THUMBNAIL TRICK (FIXED)
        if (typeof imageUrl === "string" && imageUrl.includes("res.cloudinary.com")) {
          try {
            const cleanUrl = imageUrl.split("?")[0];
            const lastDotIndex = cleanUrl.lastIndexOf(".");

            if (lastDotIndex !== -1) {
              let thumbnailUrl = cleanUrl.substring(0, lastDotIndex) + ".jpg";

              // 1. Force strict JPEG format (f_jpg), limit dimensions to 320x320, and compress (q_50)
              // This guarantees the file size is tiny enough to pass WhatsApp's filter.
              thumbnailUrl = thumbnailUrl.replace("/upload/", "/upload/w_320,h_320,c_limit,q_50,f_jpg/");
              console.log(" thumnail url is ", thumbnailUrl)

              const thumbRes = await fetch(thumbnailUrl);
              if (thumbRes.ok) {
                const thumbBuffer = Buffer.from(await thumbRes.arrayBuffer());

                // 2. Attach the Buffer directly (Baileys loves Buffers)
                content.jpegThumbnail = thumbBuffer;

                // 3. 🛑 THE MISSING INGREDIENT: You MUST declare the dimensions for video thumbnails
                // Without these two lines, WhatsApp silently deletes the thumbnail on the receiving phone.
                content.width = 320;
                content.height = 270;
              }
            }
          } catch (err) {
            console.warn("⚠️ Failed to fetch Cloudinary thumbnail:", err.message);
          }
        }
      } else if (mediaType === "document") {
        content = {
          document: mediaSource,
          mimetype: getMimeType(imageUrl),
          fileName: fileName || imageUrl.split("/").pop() || "file",
          caption: message,
        };
      } else {
        content = { image: mediaSource, caption: message };
      }
    } else {
      // 5. Fallback: Standard Text + Link Previews
      let text = message;
      content = { text };

      if (linkPreview?.sourceUrl) {
        const hasValidThumbnail = typeof linkPreview.thumbnailUrl === "string" && /^https?:\/\//i.test(linkPreview.thumbnailUrl);

        if (!text.includes(linkPreview.sourceUrl)) {
          text = `${text}\n${linkPreview.sourceUrl}`;
          content.text = text;
        }

        let jpegThumbnail;
        if (hasValidThumbnail) {
          try {
            const res = await fetch(linkPreview.thumbnailUrl);
            jpegThumbnail = Buffer.from(await res.arrayBuffer());
          } catch (err) {
            console.warn("⚠️ Failed to fetch link preview thumbnail:", err.message);
          }
        }

        content.linkPreview = {
          "canonical-url": linkPreview.sourceUrl,
          "matched-text": linkPreview.sourceUrl,
          title: linkPreview.title || "",
          description: linkPreview.body || "",
          ...(jpegThumbnail ? { jpegThumbnail } : {}),
        };
      }
    }

    // 6. Send the payload
    const result = await sock.sendMessage(jid, content);
    recordSend({
      adminId, channel: "whatsapp_baileys", source: extra.source || "other", recipient: String(to),
      runId: extra.runId ?? null, customerId: extra.customerId ?? null,
      providerMessageId: result?.key?.id, status: "sent"
    });

    // If it's a location, send the caption text separately as a follow-up message
    if (mediaType === "location" && message) {
      await delay(500);
      await sock.sendMessage(jid, { text: message }).catch(() => { });
    }

    console.log("✅ WhatsApp sent:", result?.key?.id);
    return result;
  } catch (error) {
    console.error("❌ WhatsApp error:", error.message);
    recordSend({
      adminId, channel: "whatsapp_baileys", source: extra.source || "other", recipient: String(to),
      runId: extra.runId ?? null, customerId: extra.customerId ?? null,
      status: "failed", error: String(error.message).slice(0, 500)
    });
    throw error;
  }
};

export const sendBaileysWhatsAppDirect = async (adminId, to, message, fileBuffer = null, extra = {}) => {
  try {
    let sock = getWhatsAppSocket(adminId);

    // 1. 🛑 FIX: Wait if socket is completely missing OR if it's currently reconnecting
    if (!sock || getWhatsAppConnectionState(adminId).status !== 'connected') {
      console.log("🚦 WhatsApp engine is reconnecting or asleep. Waiting...");
      if (!sock) {
        if (!(await hasLinkedSession(adminId))) throw new Error("WhatsApp is not linked for this admin");
        initWhatsApp(adminId).catch((e) => console.error(`[${adminId}] init failed:`, e.message));
      }

      let retries = 0;
      while (getWhatsAppConnectionState(adminId).status !== 'connected' && retries < 15) {
        await delay(1000);
        retries++;
      }

      sock = getWhatsAppSocket(adminId);
      if (!sock || getWhatsAppConnectionState(adminId).status !== 'connected') {
        throw new Error("WhatsApp socket failed to stabilize/connect.");
      }
    }

    const {
      mediaType = "text",
      fileName = "file",
      mimetype = "application/octet-stream",
      location = null,
      poll = null,
      humanize = true,
    } = extra;

    const jid = `${to}@s.whatsapp.net`;

    // 2. 🛑 FIX: Safely wrap presence updates so they never crash the actual send
    await waitForTurn(adminId);                         // always: the controller only sets humanize for the first customer
    sock = getWhatsAppSocket(adminId) || sock;          // socket may have reconnected while waiting

    if (humanize) {
      await sock.presenceSubscribe(jid).catch(() => { });
      await delay(rand(1500, 4000));

      const isRecording = mediaType === "video";
      await sock.sendPresenceUpdate(isRecording ? "recording" : "composing", jid).catch(() => { });

      await delay(fileBuffer ? rand(2000, 4000) : typingTime(message));

      await sock.sendPresenceUpdate("paused", jid).catch(() => { });
    }

    let content;

    // 3. Build Content
    if (mediaType === "poll" && poll?.name) {
      content = {
        poll: {
          name: poll.name,
          values: poll.options,
          selectableCount: poll.selectableCount || 1,
        },
      };
    } else if (mediaType === "location" && location?.lat && location?.lng) {
      content = {
        location: {
          degreesLatitude: Number(location.lat),
          degreesLongitude: Number(location.lng),
          name: location.name || "",
          address: location.address || "",
        },
      };
    } else if (fileBuffer) {
      if (mediaType === "video") {
        content = { video: fileBuffer, caption: message };
      } else if (mediaType === "document") {
        content = {
          document: fileBuffer,
          mimetype: mimetype,
          fileName: fileName,
          caption: message,
        };
      } else {
        content = { image: fileBuffer, caption: message };
      }
    } else {
      content = { text: message };
    }

    // 4. Send with Auto-Retry
    let result;
    try {
      result = await sock.sendMessage(jid, content);

    } catch (sendError) {
      // If it STILL throws a connection closed (e.g. timeout during a large file upload), retry once.
      if (sendError.message.toLowerCase().includes('close') || sendError.message.toLowerCase().includes('timeout')) {
        console.warn("⚠️ WhatsApp connection dropped during upload. Retrying once...");
        await delay(10000);
        sock = getWhatsAppSocket(adminId); // Grab fresh socket reference
        if (sock && getWhatsAppConnectionState(adminId).status === 'connected') {
          result = await sock.sendMessage(jid, content);
        } else {
          throw sendError;
        }
      } else {
        throw sendError;
      }
    }

    recordSend({
      adminId, channel: "whatsapp_baileys", source: extra.source || "other",
      runId: extra.runId ?? null, customerId: extra.customerId ?? null,
      recipient: String(to),
      providerMessageId: result?.key?.id, status: "sent"
    });

    // Follow up location with caption if needed safely
    if (mediaType === "location" && message) {
      await delay(10000);
      await sock.sendMessage(jid, { text: message }).catch(() => { });
    }

    return result;
  } catch (error) {
    console.error("❌ WhatsApp Direct Send error:", error.message);
    recordSend({
      adminId, channel: "whatsapp_baileys", source: extra.source || "other", recipient: String(to),
      runId: extra.runId ?? null, customerId: extra.customerId ?? null,
      status: "failed", error: String(error.message).slice(0, 500)
    });
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