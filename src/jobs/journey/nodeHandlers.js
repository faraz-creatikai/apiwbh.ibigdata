import { sendEmail } from "../../config/mailer.js";
import { sendBaileysWhatsApp } from "../../config/twilio.js";
import { toWaNumber } from "../../utils/phone.js";

/**
 * One entry per node type that does real work. journeyProcessor.js calls
 * nodeHandlers[node.type] for LIVE runs (test runs stay simulated).
 *
 * A handler receives { node, config, triggerData, execution, journey } and
 * returns { message, level? } which is written to the execution log.
 * Throwing fails the execution; the worker then retries it (up to 3 times).
 *
 * To add a tool later (whatsapp, sms, ...): add one function below.
 */

const escapeHtml = (value) =>
    String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Replaces {{firstName}}, {{city}}, ... with values from triggerData.
const fill = (text, data, transform = (v) => v) =>
    String(text ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
        transform(data[key] ?? "")
    );

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
        const to = triggerData;
        console.log("to is ", to, "trigger is ", triggerData, " provider is ", config.provider, " or ", config)
        if (!to.phone) {
            return { level: "warning", message: `${node.title} skipped: customer has no whatsapp` };
        }
        if (config.provider === "baileys") {
            if (!config.message) {
                return { level: "warning", message: `${node.title} skipped: whatsapp has no content.` };
            }

            const message = config.message;

            console.log(" message: ", message, "enrolled:  ", to, "provider ", config.provider)

            const formattedPhone = toWaNumber(to.phone, to.CountryCode);

            await sendBaileysWhatsApp(journey.createdById, formattedPhone, message)
            return { message: `${node.title}: baileys whatsapp sent to ${to}.` };


        }
        else if (config.provider === "meta") {
        }
    },

};