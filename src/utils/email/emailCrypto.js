import crypto from "node:crypto"; // "node:" prefix on purpose: never resolve to the npm "crypto" stub package

/**
 * AES-256-GCM encryption for stored mailbox passwords.
 *
 * Requires EMAIL_CONFIG_SECRET in .env (any long random string, 32+ chars recommended).
 *   generate one:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * IMPORTANT: if you change/lose this secret, every stored password becomes undecryptable
 * and each admin has to reconnect their mailbox.
 */
const getKey = () => {
  const secret = process.env.EMAIL_CONFIG_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "EMAIL_CONFIG_SECRET is missing or too short (min 16 chars). Add it to your .env before connecting mailboxes."
    );
  }
  return crypto.createHash("sha256").update(secret).digest(); // 32 bytes
};

export const encryptSecret = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
};

export const decryptSecret = (payload) => {
  const [version, iv, tag, data] = String(payload || "").split(":");
  if (version !== "v1" || !iv || !tag || !data) {
    throw new Error("Stored email credentials are corrupted. Please reconnect your email.");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    if (/EMAIL_CONFIG_SECRET/.test(err.message)) throw err;
    throw new Error("Could not decrypt stored email credentials (secret changed?). Please reconnect your email.");
  }
};