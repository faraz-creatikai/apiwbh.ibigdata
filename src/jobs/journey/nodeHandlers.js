import prisma from "../../config/prismaClient.js";
import { sendEmail } from "../../config/mailer.js";
import { sendBaileysWhatsApp } from "../../config/twilio.js";
import { toWaNumber } from "../../utils/phone.js";

/**
 * One entry per node type that does real work. journeyProcessor.js calls
 * nodeHandlers[node.type] for LIVE runs (test runs stay simulated).
 *
 * A handler receives { node, config, triggerData, execution, journey } and
 * returns { message, level? } which is written to the execution log.
 * It must ALWAYS return that object (the processor reads .message).
 * Throwing fails the execution; the worker then retries it (up to 3 times).
 *
 * To add a tool later (sms, ...): add one function below.
 */

const escapeHtml = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Finds a value for a placeholder key. Not case-sensitive, so templates written
// with {{Name}}, {{City}}, {{ContactNumber}}, {{CustomerFields.Budget}} all work.
const lookup = (data, key) => {
  const k = key.toLowerCase();
  if (k.startsWith("customerfields.")) return data.customFields?.[key.slice("customerfields.".length)];
  if (k === "contactnumber") return data.phone;
  return Object.entries(data).find(([name]) => name.toLowerCase() === k)?.[1];
};

// Replaces {{name}}, {{city}}, ... with the lead's data.
// A placeholder we don't recognise is left exactly as written.
const fill = (text, data, transform = (v) => v) =>
  String(text ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const value = lookup(data, key);
    return value === undefined || value === null ? match : transform(String(value));
  });

// Template columns can be stored as JSON text or as real JSON.
const asJson = (v, fallback = null) => {
  if (v == null || v === "") return fallback;
  if (typeof v === "string") {
    try { return JSON.parse(v) ?? fallback; } catch { return fallback; }
  }
  return v;
};

// Turns a saved WhatsApp template into the arguments sendBaileysWhatsApp expects.
// Same rule as the template picker's preview, so what you preview is what is sent.
const fromTemplate = (tpl, data) => {
  const files = asJson(tpl.whatsappImage, []);
  const fileUrl = Array.isArray(files) ? files.find(Boolean) : null;
  const poll = asJson(tpl.whatsappPoll);
  const loc = asJson(tpl.whatsappLocation);
  const link = asJson(tpl.whatsappLinkPreview);

  let mediaType = "text";
  if (["image", "video", "document"].includes(tpl.whatsappMediaType) && fileUrl) mediaType = tpl.whatsappMediaType;
  else if (poll?.name) mediaType = "poll";
  else if (loc && loc.lat != null && loc.lng != null) mediaType = "location";

  return {
    message: fill(tpl.body, data),
    mediaUrl: ["image", "video", "document"].includes(mediaType) ? fileUrl : null,
    extra: {
      mediaType,
      fileName: tpl.whatsappFileName || "",
      linkPreview: link?.sourceUrl ? link : null,
      location: mediaType === "location" ? loc : null,
      poll: mediaType === "poll" ? poll : null,
    },
  };
};

export const nodeHandlers = {
  async email({ node, config, triggerData, execution, journey }) {
    const to = String(triggerData.email ?? "").trim();
    if (!to) {
      return { level: "warning", message: `${node.title} skipped: customer has no email address.` };
    }
    if (!config.subject && !config.message) {
      return { level: "warning", message: `${node.title} skipped: email has no subject or content.` };
    }

    const subject = fill(config.subject, triggerData) || "(no subject)";
    // Template mode: the message is already HTML, so keep it as is.
    // Custom mode: plain text, so escape it and turn line breaks into <br>.
    const html =
      config.messageType === "template"
        ? fill(config.message, triggerData)
        : fill(config.message, triggerData, escapeHtml).replace(/\n/g, "<br>");

    // Sent from the journey owner's connected mailbox (default SMTP if none).
    await sendEmail(to, subject, html, {
      adminId: journey.createdById,
      source: "journey",
      runId: execution.id,
      customerId: execution.customerId,
    });

    return { message: `${node.title}: email sent to ${to}.` };
  },

  async whatsapp({ node, config, triggerData, execution, journey }) {
    if (!triggerData.phone) {
      return { level: "warning", message: `${node.title} skipped: customer has no phone number.` };
    }
    const phone = toWaNumber(triggerData.phone, triggerData.countryCode);

    // ───────────── BAILEYS ─────────────
    if (config.provider === "baileys") {
      let message = "";
      let mediaUrl = null;
      let extra = {};

      if (config.messageType !== "custom") {
        // Template mode (this is also the builder's default mode).
        if (!config.templateId) {
          return { level: "warning", message: `${node.title} skipped: no WhatsApp template selected.` };
        }
        // NOTE: change `template` if your Prisma model for templates has another name.
        const tpl = await prisma.template.findUnique({ where: { id: config.templateId } });
        if (!tpl) {
          return { level: "warning", message: `${node.title} skipped: the selected template no longer exists.` };
        }
        ({ message, mediaUrl, extra } = fromTemplate(tpl, triggerData));
      } else {
        message = fill(config.message, triggerData);
      }

      if (!message && !mediaUrl && !extra.poll && !extra.location) {
        return { level: "warning", message: `${node.title} skipped: WhatsApp message has no content.` };
      }

      // Uses the journey owner's linked WhatsApp. It keeps the 45-90s gap between
      // messages (ban protection), so each message takes about a minute to go out.
      await sendBaileysWhatsApp(journey.createdById, phone, message, mediaUrl, {
        ...extra,
        source: "journey",
        runId: execution.id,
        customerId: execution.customerId,
      });

      return { message: `${node.title}: WhatsApp (Baileys) sent to ${phone}.` };
    }

    // ───────────── META ─────────────
    // Add the Meta Cloud API sending here later. You already have:
    //   phone (digits with country code), config (the node settings),
    //   triggerData (the lead), fill(text, triggerData) for {{placeholders}}.
    // Always return { message, level? }.
    if (config.provider === "meta") {
      return { level: "warning", message: `${node.title} skipped: Meta WhatsApp is not connected yet.` };
    }

    // Any other value of config.provider
    return { level: "warning", message: `${node.title} skipped: unknown WhatsApp provider "${config.provider}".` };
  },
};