import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { assertPublicHost, resolvePlan, manualPlan } from "./emailProviders.js";

/* ====================================================================
 * SMTP options — ONE place that decides secure / requireTLS, used by
 * both verification and real sending so they can never disagree.
 *   secure:true  -> implicit TLS (port 465)
 *   secure:false -> STARTTLS (port 587/25/2525) and requireTLS:true, so
 *                   the password is NEVER sent over an unencrypted link.
 * Certificates are always validated (we never disable rejectUnauthorized).
 * ==================================================================== */
export const buildSmtpOptions = ({ host, port, secure }, { user, pass }, { pooled = false, verifyMode = false } = {}) => ({
  host,
  port,
  secure: !!secure,
  requireTLS: !secure,
  auth: { user, pass },
  connectionTimeout: verifyMode ? 10_000 : 20_000,
  greetingTimeout: verifyMode ? 10_000 : 20_000,
  socketTimeout: verifyMode ? 20_000 : 60_000,
  ...(pooled ? { pool: true, maxConnections: 2, maxMessages: 100 } : {}),
});

export const classifySmtpError = (err) => {
  const msg = `${err?.message || ""} ${err?.response || ""}`.toLowerCase();
  const rc = err?.responseCode;
  if (err?.code === "EAUTH" || [530, 534, 535].includes(rc)) {
    if (/5\.7\.139|5\.7\.30|basic authentication is (disabled|not supported)|smtpclientauthentication|basicauthblocked/.test(msg)) return "basic_auth_disabled";
    if (/application-specific|app password|app-specific|5\.7\.9\b|web login required|less secure/.test(msg)) return "app_password_required";
    return "auth_failed";
  }
  if (/certificate|altname|self[- ]signed|hostname\/ip does not match|err_tls_cert/.test(msg)) return "tls_cert";
  return "unreachable";
};

export const verifySmtp = async (candidate, creds) => {
  const t = nodemailer.createTransport(buildSmtpOptions(candidate, creds, { verifyMode: true }));
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: classifySmtpError(err), message: err.message };
  } finally {
    t.close();
  }
};

const SENT_NAMES = ["sent", "inbox.sent", "sent items", "sent messages", "sent mail", "[gmail]/sent mail"];

/** Logs into IMAP and finds the Sent folder (special-use \Sent flag first, then common names). */
export const probeImap = async (imap, { user, pass }) => {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: !!imap.secure,
    auth: { user: imap.user || user, pass },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  client.on("error", () => {}); // unhandled ImapFlow 'error' events would crash the process
  try {
    await client.connect();
    const boxes = await client.list();
    const sent =
      boxes.find((b) => b.specialUse === "\\Sent") ||
      SENT_NAMES.map((n) => boxes.find((b) => b.path.toLowerCase() === n)).find(Boolean);
    return { ok: true, sentFolder: sent?.path || null };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
    try { client.close(); } catch { /* ignore */ }
  }
};

const FAIL_MESSAGES = {
  AUTH_FAILED: "The mail server rejected this email/password.",
  APP_PASSWORD_REQUIRED: "The mail server requires an app-specific password instead of your normal password.",
  BASIC_AUTH_DISABLED: "The mail server has switched off password login (SMTP basic authentication) for this account.",
  TLS_CERT_MISMATCH: "The mail server's security certificate does not match its hostname, so we refused to send your password to it.",
  UNREACHABLE: "Could not connect to a mail server for this address.",
};

const failure = (code, plan, extra = {}) => ({
  ok: false,
  code,
  message: FAIL_MESSAGES[code] || "Could not connect.",
  hint: plan?.authHint && ["AUTH_FAILED", "APP_PASSWORD_REQUIRED"].includes(code) ? plan.authHint : undefined,
  needsAdvanced: code === "UNREACHABLE" && ["guess", "autoconfig", "mx"].includes(plan?.source),
  provider: plan?.id,
  providerLabel: plan?.label,
  ...extra,
});

/**
 * detectAndVerify — the heart of "admin only gives credentials".
 * Nothing is ever saved by this function; it returns either a fully verified
 * config or a precise reason why not.
 */
export const detectAndVerify = async ({ email, password, advanced }) => {
  email = String(email).trim().toLowerCase();

  const plan = advanced?.smtpHost ? manualPlan(advanced) : await resolvePlan(email);
  if (plan.invalidDomain) {
    return { ok: false, code: "INVALID_DOMAIN", message: "This email domain does not exist or cannot receive email. Check the address for typos." };
  }
  if (plan.unsupported) {
    return { ok: false, code: plan.unsupported.code, message: plan.unsupported.message, provider: plan.id, providerLabel: plan.label };
  }

  const pass = plan.stripPasswordSpaces ? String(password).replace(/\s+/g, "") : String(password);
  const tried = [];
  const authFailedHosts = new Set();
  let authKind = null;
  let certFailed = false;
  let winner = null;

  outer: for (const group of plan.groups) {
    for (const cand of group.smtp) {
      if (authFailedHosts.has(cand.host)) continue; // same server => same credential verdict on the other port
      try {
        await assertPublicHost(cand.host);
      } catch (e) {
        tried.push({ host: cand.host, port: cand.port, result: e.code === "PRIVATE_HOST" ? "blocked_private_address" : "dns_not_found" });
        continue;
      }
      const user = cand.user || email;
      const r = await verifySmtp(cand, { user, pass });
      tried.push({ host: cand.host, port: cand.port, secure: cand.secure, result: r.ok ? "ok" : r.kind });
      if (r.ok) {
        winner = { cand, group, user };
        break outer;
      }
      if (["auth_failed", "app_password_required", "basic_auth_disabled"].includes(r.kind)) {
        authFailedHosts.add(cand.host);
        // keep the most specific auth verdict we have seen
        if (!authKind || authKind === "auth_failed") authKind = r.kind;
      } else if (r.kind === "tls_cert") {
        certFailed = true;
      }
    }
  }

  if (!winner) {
    if (authKind === "basic_auth_disabled") return failure("BASIC_AUTH_DISABLED", plan, { tried });
    if (authKind === "app_password_required") return failure("APP_PASSWORD_REQUIRED", plan, { tried });
    if (authKind) return failure("AUTH_FAILED", plan, { tried });
    if (certFailed) return failure("TLS_CERT_MISMATCH", plan, { tried });
    return failure("UNREACHABLE", plan, { tried });
  }

  /* ---- Sent-folder saving (optional, never blocks connecting) ---- */
  const warnings = [...plan.warnings];
  let imapInfo = null;
  let sentFolder = null;

  if (!plan.autoSavesSent) {
    for (const im of winner.group.imap) {
      try { await assertPublicHost(im.host); } catch { continue; }
      const r = await probeImap(im, { user: winner.user, pass });
      if (r.ok && r.sentFolder) {
        imapInfo = { host: im.host, port: im.port, secure: im.secure, user: im.user || winner.user };
        sentFolder = r.sentFolder;
        break;
      }
    }
    if (!imapInfo) {
      warnings.push("Emails will send normally, but copies could not be saved to the Sent folder (IMAP login or Sent folder was not found).");
    }
  }

  return {
    ok: true,
    provider: plan.id,
    providerLabel: plan.label,
    source: plan.source,
    smtp: { host: winner.cand.host, port: winner.cand.port, secure: winner.cand.secure, user: winner.user },
    imap: imapInfo,
    saveToSent: !!imapInfo,
    sentFolder,
    password: pass, // the (possibly space-stripped) password that actually worked — caller encrypts it
    warnings,
    tried,
  };
};