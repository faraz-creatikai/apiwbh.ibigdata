import dns from "node:dns/promises";
import net from "node:net";

/* ====================================================================
 * 1. SSRF GUARD
 * The admin controls the email domain, so we must never let detection
 * connect to private/internal addresses (127.x, 10.x, 192.168.x, cloud
 * metadata 169.254.x ...). Set EMAIL_ALLOW_PRIVATE_HOSTS=1 only if you
 * deliberately run an internal mail relay.
 * ==================================================================== */
const blocked = new net.BlockList();
[
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
].forEach(([addr, prefix]) => blocked.addSubnet(addr, prefix, "ipv4"));
blocked.addAddress("::1", "ipv6");
blocked.addAddress("::", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

export async function assertPublicHost(host) {
  if (process.env.EMAIL_ALLOW_PRIVATE_HOSTS === "1") return;
  let addrs;
  try {
    const family = net.isIP(host);
    addrs = family ? [{ address: host, family }] : await dns.lookup(host, { all: true });
  } catch {
    throw Object.assign(new Error(`${host} does not resolve`), { code: "DNS" });
  }
  for (const { address, family } of addrs) {
    if (blocked.check(address, family === 6 ? "ipv6" : "ipv4")) {
      throw Object.assign(new Error(`${host} points to a private address`), { code: "PRIVATE_HOST" });
    }
  }
}

/* ====================================================================
 * 2. PROVIDER REGISTRY (known-good values — the most reliable layer)
 * ==================================================================== */
const smtpPair = (host) => [
  { host, port: 465, secure: true },   // implicit TLS first
  { host, port: 587, secure: false },  // then STARTTLS (always with requireTLS)
];
const imap993 = (host) => ({ host, port: 993, secure: true });

const ZOHO_REGIONS = ["com", "in", "eu", "com.au", "jp", "com.cn"];
const zohoRegions = ({ domain, mxHosts }) => {
  const fromMx = mxHosts
    .map((h) => h.match(/^mx\d*\.zoho\.(com\.au|com\.cn|com|in|eu|jp)$/)?.[1])
    .find(Boolean);
  const fromDomain = domain.match(/^zoho(?:mail)?\.(com\.au|com\.cn|com|in|eu|jp)$/)?.[1];
  const region = fromMx || fromDomain;
  return region ? [region] : ZOHO_REGIONS;
};

const PROVIDERS = [
  {
    id: "gmail",
    label: "Gmail / Google Workspace",
    domains: ["gmail.com", "googlemail.com"],
    mx: [/(^|\.)google\.com$/, /(^|\.)googlemail\.com$/],
    groups: () => [{ smtp: smtpPair("smtp.gmail.com"), imap: [imap993("imap.gmail.com")] }],
    autoSavesSent: true, // Gmail stores SMTP-sent mail in Sent itself
    stripPasswordSpaces: true, // Google shows app passwords as "abcd efgh ijkl mnop"
    authHint:
      "Gmail does not accept your normal password. Turn on 2-Step Verification, then create an App Password at myaccount.google.com/apppasswords and paste that 16-character password here. (Google Workspace admins can also block app passwords.)",
  },
  {
    // Personal Outlook.com / Hotmail / Live / MSN
    id: "outlook_personal",
    label: "Outlook.com / Hotmail (personal)",
    domainRegex: /^(outlook|hotmail|live|msn)\.[a-z.]+$/,
    unsupported: {
      code: "OAUTH_REQUIRED",
      message:
        "Personal Outlook.com / Hotmail / Live accounts no longer allow SMTP login with a password or app password (Microsoft switched basic authentication off on 16 Sept 2024). They need OAuth sign-in, which this connection form does not support yet. Use a Gmail, Zoho, Hostinger or custom-domain mailbox instead.",
    },
    groups: () => [],
  },
  {
    // Microsoft 365 / Exchange Online (business) — detected by MX
    id: "microsoft365",
    label: "Microsoft 365 / Outlook (business)",
    mx: [/\.mail\.protection\.outlook\.com$/, /\.olc\.protection\.outlook\.com$/],
    groups: () => [
      { smtp: [{ host: "smtp.office365.com", port: 587, secure: false }], imap: [imap993("outlook.office365.com")] },
    ],
    autoSavesSent: true,
    authHint:
      "Microsoft 365 rejected the login. Your Microsoft 365 admin must enable 'Authenticated SMTP' for this mailbox (Exchange admin center -> Mailbox -> Manage email apps), and if MFA is on you need an app password.",
    warnings: [
      "Microsoft is disabling password (basic) SMTP login by default for Microsoft 365 tenants from the end of December 2026. If sending suddenly fails after that, the tenant admin must re-enable SMTP AUTH or the account needs OAuth (not supported yet).",
    ],
  },
  {
    id: "zoho",
    label: "Zoho Mail",
    domains: ["zoho.com", "zohomail.com", "zoho.in", "zohomail.in", "zoho.eu", "zohomail.eu", "zoho.com.au", "zohomail.com.au", "zoho.jp", "zohomail.jp"],
    mx: [/^mx\d*\.zoho\.(com|in|eu|com\.au|jp|com\.cn)$/],
    groups: (ctx) =>
      zohoRegions(ctx).map((tld) => ({ smtp: smtpPair(`smtp.zoho.${tld}`), imap: [imap993(`imap.zoho.${tld}`)] })),
    authHint:
      "Zoho rejected the login. Make sure IMAP/SMTP access is enabled (Zoho Mail -> Settings -> Mail Accounts -> POP/IMAP) and, if two-factor is on, use an app-specific password from accounts.zoho.com. Note: external SMTP access needs a paid Zoho plan.",
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    domains: ["yahoo.com", "yahoo.in", "yahoo.co.in", "yahoo.co.uk", "ymail.com", "rocketmail.com"],
    mx: [/yahoodns\.net$/],
    groups: () => [{ smtp: smtpPair("smtp.mail.yahoo.com"), imap: [imap993("imap.mail.yahoo.com")] }],
    stripPasswordSpaces: true,
    authHint: "Yahoo requires an App Password (Yahoo Account Security -> Generate app password), not your normal password.",
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    groups: () => [
      { smtp: [{ host: "smtp.mail.me.com", port: 587, secure: false }], imap: [imap993("imap.mail.me.com")] },
    ],
    stripPasswordSpaces: true,
    authHint: "iCloud requires an app-specific password (appleid.apple.com -> Sign-In and Security -> App-Specific Passwords).",
  },
  {
    id: "aol",
    label: "AOL Mail",
    domains: ["aol.com"],
    groups: () => [{ smtp: smtpPair("smtp.aol.com"), imap: [imap993("imap.aol.com")] }],
    authHint: "AOL requires an app password (AOL Account Security -> Generate app password).",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm"],
    mx: [/messagingengine\.com$/],
    groups: () => [{ smtp: smtpPair("smtp.fastmail.com"), imap: [imap993("imap.fastmail.com")] }],
    authHint: "Fastmail requires an app password (Settings -> Privacy & Security -> Integrations -> New app password).",
  },
  {
    id: "hostinger",
    label: "Hostinger Email",
    mx: [/\.hostinger\.[a-z.]+$/],
    groups: () => [{ smtp: smtpPair("smtp.hostinger.com"), imap: [imap993("imap.hostinger.com")] }],
    authHint: "Hostinger rejected the login. Use the full email address and the mailbox password set in hPanel -> Emails.",
  },
  {
    id: "titan",
    label: "Titan Email",
    mx: [/\.titan\.email$/],
    groups: () => [{ smtp: smtpPair("smtp.titan.email"), imap: [imap993("imap.titan.email")] }],
    authHint: "Titan rejected the login. Use the full email address and the mailbox password.",
  },
  {
    id: "namecheap",
    label: "Namecheap Private Email",
    mx: [/privateemail\.com$/],
    groups: () => [{ smtp: smtpPair("mail.privateemail.com"), imap: [imap993("mail.privateemail.com")] }],
    authHint: "Private Email rejected the login. Use the full email address and the mailbox password.",
  },
  {
    id: "godaddy",
    label: "GoDaddy Email",
    mx: [/secureserver\.net$/],
    groups: () => [{ smtp: smtpPair("smtpout.secureserver.net"), imap: [imap993("imap.secureserver.net")] }],
    authHint: "GoDaddy rejected the login. Use the full email address and the mailbox password.",
  },
  {
    id: "proton",
    label: "Proton Mail",
    domains: ["proton.me", "protonmail.com", "pm.me", "protonmail.ch"],
    mx: [/protonmail\.ch$/],
    unsupported: {
      code: "UNSUPPORTED_PROVIDER",
      message:
        "Proton Mail does not offer SMTP login to third-party apps unless you run Proton Mail Bridge on a local computer, so it cannot be connected here.",
    },
    groups: () => [],
  },
];

export const getProviderLabel = (id) => PROVIDERS.find((p) => p.id === id)?.label || id;

const toPlan = (p, source, ctx) => ({
  id: p.id,
  label: p.label,
  source,
  groups: p.groups(ctx),
  autoSavesSent: !!p.autoSavesSent,
  stripPasswordSpaces: !!p.stripPasswordSpaces,
  authHint: p.authHint || null,
  warnings: p.warnings || [],
  unsupported: p.unsupported || null,
});

const matchesDomain = (p, domain) =>
  (p.domains && p.domains.includes(domain)) || (p.domainRegex && p.domainRegex.test(domain));

/** Pure function (no network): match known provider from MX hostnames. */
export function planFromMxHosts(domain, mxHosts) {
  for (const p of PROVIDERS) {
    if (p.mx && mxHosts.some((h) => p.mx.some((re) => re.test(h)))) return toPlan(p, "mx", { domain, mxHosts });
  }
  return null;
}

/** Pure function (no network): match known provider from the email domain. */
export function planFromDomain(domain) {
  for (const p of PROVIDERS) {
    if (matchesDomain(p, domain)) return toPlan(p, "registry", { domain, mxHosts: [] });
  }
  return null;
}

/* ====================================================================
 * 3. DNS / AUTOCONFIG / GUESSING for providers not in the registry
 * ==================================================================== */
const lookupMx = async (domain) => {
  try {
    const r = await dns.resolveMx(domain);
    return r.sort((a, b) => a.priority - b.priority).map((x) => x.exchange.toLowerCase().replace(/\.$/, ""));
  } catch {
    return [];
  }
};

const baseDomain = (host) => {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const [sld, tld] = parts.slice(-2);
  const isCompound = tld.length === 2 && /^(com|co|org|net|gov|ac|edu)$/.test(sld);
  return parts.slice(isCompound ? -3 : -2).join(".");
};

const xmlTag = (xml, name) => (xml.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i")) || [])[1];
const xmlBlocks = (xml, kind, type) =>
  [...xml.matchAll(new RegExp(`<${kind}\\s+type="${type}"[^>]*>([\\s\\S]*?)</${kind}>`, "gi"))].map((m) => m[1]);

/** Parses Mozilla/Thunderbird autoconfig XML (config-v1.1). */
export function parseAutoconfig(xml, email) {
  const [local, domain] = email.split("@");
  const sub = (s) =>
    s.replaceAll("%EMAILADDRESS%", email).replaceAll("%EMAILLOCALPART%", local).replaceAll("%EMAILDOMAIN%", domain);
  const okAuth = (block) => {
    const auths = [...block.matchAll(/<authentication>\s*([^<]*?)\s*<\/authentication>/gi)].map((m) => m[1].toLowerCase());
    return auths.length === 0 || auths.some((a) => ["password-cleartext", "password-encrypted", "plain", "secure"].includes(a));
  };
  const toServer = (block) => {
    const host = xmlTag(block, "hostname");
    const port = parseInt(xmlTag(block, "port"), 10);
    const socket = (xmlTag(block, "socketType") || "").toUpperCase();
    if (!host || !port || !["SSL", "STARTTLS"].includes(socket) || !okAuth(block)) return null;
    const username = xmlTag(block, "username");
    return { host: sub(host), port, secure: socket === "SSL", user: username ? sub(username) : undefined };
  };
  const smtp = xmlBlocks(xml, "outgoingServer", "smtp").map(toServer).filter(Boolean);
  const imap = xmlBlocks(xml, "incomingServer", "imap").map(toServer).filter(Boolean);
  return { smtp, imap };
}

const fetchXml = async (url) => {
  try {
    const host = new URL(url).hostname;
    await assertPublicHost(host);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length < 200_000 && text.includes("<clientConfig") ? text : null;
  } catch {
    return null;
  }
};

const fetchAutoconfig = async (email, domain, mxHosts) => {
  const bases = [...new Set(mxHosts.slice(0, 2).map(baseDomain))].filter((b) => b !== domain);
  const urls = [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    ...bases.map((b) => `https://autoconfig.thunderbird.net/v1.1/${b}`),
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
  ];
  for (const url of urls) {
    const xml = await fetchXml(url);
    if (!xml) continue;
    const { smtp, imap } = parseAutoconfig(xml, email);
    if (smtp.length) {
      return {
        id: "autoconfig",
        label: "Auto-detected settings",
        source: "autoconfig",
        groups: [{ smtp: smtp.slice(0, 4), imap: imap.slice(0, 2) }],
        autoSavesSent: false,
        stripPasswordSpaces: false,
        authHint: null,
        warnings: [],
        unsupported: null,
      };
    }
  }
  return null;
};

const guessPlan = (domain, mxHosts) => {
  const bases = [...new Set([domain, ...mxHosts.slice(0, 2).map(baseDomain)])];
  const smtpHosts = [];
  for (const b of bases) smtpHosts.push(`smtp.${b}`, `mail.${b}`);
  for (const mx of mxHosts.slice(0, 2)) if (mx.endsWith(`.${domain}`) || mx === domain) smtpHosts.push(mx);
  const imapHosts = [];
  for (const b of bases) imapHosts.push(`imap.${b}`, `mail.${b}`);
  return {
    id: "custom",
    label: "Custom domain mail server",
    source: "guess",
    groups: [{
      smtp: [...new Set(smtpHosts)].slice(0, 6).flatMap(smtpPair),
      imap: [...new Set(imapHosts)].slice(0, 4).map(imap993),
    }],
    autoSavesSent: false,
    stripPasswordSpaces: false,
    authHint: null,
    warnings: [],
    unsupported: null,
  };
};

/** Full detection: registry by domain -> MX -> autoconfig -> guess. */
export async function resolvePlan(email) {
  const domain = email.split("@")[1].toLowerCase();

  const byDomain = planFromDomain(domain);
  if (byDomain) return byDomain;

  const mxHosts = await lookupMx(domain);
  const byMx = planFromMxHosts(domain, mxHosts);
  if (byMx) return byMx;

  if (!mxHosts.length) {
    const resolves = await dns.lookup(domain).then(() => true).catch(() => false);
    if (!resolves) return { invalidDomain: true };
  }

  const auto = await fetchAutoconfig(email, domain, mxHosts);
  if (auto) return auto;

  return guessPlan(domain, mxHosts);
}

/** Manual (advanced) settings entered by the admin. */
export function manualPlan({ smtpHost, smtpPort, smtpUser, imapHost, imapPort }) {
  const port = Number(smtpPort) || 587;
  return {
    id: "custom",
    label: "Custom SMTP server",
    source: "manual",
    groups: [{
      smtp: [{ host: smtpHost, port, secure: port === 465, user: smtpUser || undefined }],
      imap: imapHost ? [{ host: imapHost, port: Number(imapPort) || 993, secure: (Number(imapPort) || 993) !== 143 }] : [],
    }],
    autoSavesSent: false,
    stripPasswordSpaces: false,
    authHint: null,
    warnings: [],
    unsupported: null,
  };
}