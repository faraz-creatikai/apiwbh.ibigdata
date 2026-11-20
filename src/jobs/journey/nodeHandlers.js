import { sendEmail } from "../../config/mailer.js";

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
    const html = fill(config.message, triggerData, escapeHtml).replace(/\n/g, "<br>");

    // Sent from the journey owner's connected mailbox (default SMTP if none).
    await sendEmail(to, subject, html, {
      adminId: journey.createdById,
      source: "journey",
      runId: execution.id,
      customerId: execution.customerId,
    });

    return { message: `${node.title}: email sent to ${to}.` };
  },
};