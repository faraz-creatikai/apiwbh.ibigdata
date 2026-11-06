import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ImapFlow } from "imapflow";
import dotenv from "dotenv";
import { getAdminMailer } from "../utils/email/AdminMailerConfig.js";


dotenv.config();

// 1️⃣ Create ONE pooled transporter for all emails (Saves memory & prevents blocking)
// (unchanged — this is still the default / fallback mailbox and the system-mail sender)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: true, // use true for 465
  pool: true,         // 👈 ENABLES POOLING
  maxConnections: 3,  // 👈 MAX 3 CONNECTIONS AT ONCE
  maxMessages: 100,   // 👈 REUSE CONNECTION 100 TIMES
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Helper function to pause execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 👇 CHANGED: optional `imap` argument. Without it, behaviour is identical to before (Hostinger / INBOX.Sent).
const saveToSentFolder = async (rawEmail, imap = null) => {
  const cfg = imap || {
    host: "imap.hostinger.com",
    port: 993,
    secure: true,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    folder: "INBOX.Sent",
  };

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
    logger: false,
  });
  client.on("error", () => { }); // an unhandled ImapFlow 'error' event would crash the process

  try {
    await client.connect();
    // in saveToSentFolder: return null on success, the error message on failure
    await client.append(cfg.folder, rawEmail, ["\\Seen"]);
    console.log(`✅ Email successfully saved to ${cfg.folder}`);
    return null;
  } catch (error) {
    console.error("❌ Failed to save email to Sent folder:", error);
    return error?.message || "Unknown IMAP error";
  } finally {
    // logout() throws if connect() never succeeded — that must not turn a SENT email into a "failed" one
    try { await client.logout(); } catch { /* ignore */ }
  }
};

// 3️⃣ Generic sendEmail function
// 👇 CHANGED: optional 4th argument { adminId }. Omit it (or admin has no connected mailbox) => exactly the old behaviour.
// 👇 options can also carry { text, attachments, inReplyTo, references, messageId } (inbox compose / reply).
export const sendEmail = async (to, subject, html, options = {}) => {
  try {
    const adminMailer = options?.adminId ? await getAdminMailer(options.adminId) : null;

    const fromAddress = adminMailer
      ? { name: adminMailer.fromName, address: adminMailer.email }
      : `"Aiworksforce Team" <${process.env.SMTP_USER}>`;
    const envelopeFrom = adminMailer ? adminMailer.email : process.env.SMTP_USER;

    const mailOptions = {
      from: fromAddress,
      to,
      subject,
      html,
      // 👇 NEW (all optional) — used by the inbox compose / reply controller
      ...(options.text && { text: options.text }),
      ...(options.attachments?.length && { attachments: options.attachments }), // [{ filename, path|content, contentType }]
      ...(options.inReplyTo && { inReplyTo: options.inReplyTo }),
      ...(options.references && { references: options.references }),
      ...(options.messageId && { messageId: options.messageId }),
    };

    const rawEmail = await new MailComposer(mailOptions).compile().build();

    const info = await (adminMailer ? adminMailer.transporter : transporter).sendMail({
      envelope: {
        from: envelopeFrom,
        to,
      },
      raw: rawEmail,
    });

    console.log("✅ Email sent:", info.response);

    // "skipped" = we didn't try, "saved" = copy written, "failed" = IMAP error (message in sentCopyError)
    let sentCopy = "skipped";
    let sentCopyError = null;

    if (!adminMailer || adminMailer.saveToSent) {
      sentCopyError = await saveToSentFolder(rawEmail, adminMailer ? adminMailer.imap : null);
      sentCopy = sentCopyError ? "failed" : "saved";
    }

    return { ...info, messageId: mailOptions.messageId || info.messageId, sentCopy, sentCopyError };
  } catch (error) {
    console.error("❌ Email error:", error);
    throw error;
  }
};

// 4️⃣ System-generated mail function
// (unchanged — account/welcome mails always come from the platform mailbox, never from an admin's)
export const sendSystemEmail = async (to, userName, password, role) => {
  try {
    let subject = "Your Account Has Been Created";
    let roleSpecificMessage = "";

    switch (role) {
      case "administrator":
        roleSpecificMessage = `
          <p>Welcome aboard as an <b>Administrator</b>!</p>
          <p>You now have full access to manage system operations, city admins, and users.</p>
        `;
        break;
      case "city_admin":
        roleSpecificMessage = `
          <p>Welcome aboard as a <b>City Admin</b>!</p>
          <p>You are now authorized to manage users within your assigned city.</p>
        `;
        break;
      default:
        roleSpecificMessage = `
          <p>Welcome aboard as a <b>User</b>!</p>
          <p>You can now log in and access your assigned city’s services and dashboard.</p>
        `;
        break;
    }

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 10px;">
        <h2 style="color: #333;">Welcome to Our System, ${userName} 👋</h2>
        ${roleSpecificMessage}
        <p>Here are your login details:</p>
        <ul>
          <li><b>Email:</b> ${to}</li>
          <li><b>Password:</b> ${password}</li>
        </ul>
        <p style="color: #d9534f;"><b>⚠️ Please log in and change your password immediately for security purposes.</b></p>
        <br />
        <p>Best Regards,<br/><b>Admin Team</b></p>
      </div>
    `;

    const mailOptions = {
      from: `"System Notification" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    };

    // 👈 Now uses the pooled 'transporter' instead of the redundant 'smtpTransporter'
    const info = await transporter.sendMail(mailOptions);
    console.log("✅ System email sent:", info.response);
    return info;
  } catch (error) {
    console.error("❌ System email error:", error.message);
    throw error;
  }
};

// 5️⃣ NEW: Bulk Campaign Function (Use this for sending your 500 emails)
// 👇 CHANGED: optional 4th argument `options` ({ adminId }) is passed through to sendEmail
export const sendBulkCampaign = async (usersArray, subject, htmlContent, options = {}) => {
  console.log(`🚀 Starting bulk send to ${usersArray.length} users...`);

  for (const user of usersArray) {
    try {
      await sendEmail(user.email, subject, htmlContent, options);

      // 👈 THE MAGIC TRICK: Wait 3 seconds before sending the next one
      // This protects your Hostinger IMAP connection and keeps you unblocked.
      await delay(3000);

    } catch (error) {
      console.error(`❌ Failed to send to ${user.email}`);
    }
  }

  console.log("✅ Bulk campaign finished!");
};