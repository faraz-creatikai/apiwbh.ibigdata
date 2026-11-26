// controllers/controller.googleDrive.js
import { google } from "googleapis";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { encryptKey, decryptKey } from "../utils/cryptoHelper.js";
import { createOAuth2Client, GDRIVE_SCOPES } from "../utils/google/googleDriveClient.js";
import { clientUrl } from "../config/cors-origins.js";

const fail = (err, next) =>
  next(err instanceof ApiError ? err : new ApiError(500, err.message));

// GET /api/gdrive/auth-url
export const getGDriveAuthUrl = async (req, res, next) => {
  try {
    const oauth2Client = createOAuth2Client();

    // Encrypt adminId into state to prevent tampering during OAuth redirect
    const state = encryptKey(JSON.stringify({ adminId: req.admin.id }));

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline", // Required to receive refresh_token
      prompt: "consent",      // Forces refresh_token on reconnect
      scope: GDRIVE_SCOPES,
      state,
    });

    res.json({ success: true, data: { authUrl } });
  } catch (err) {
    fail(err, next);
  }
};

// GET /api/gdrive/callback  (Public - Google redirects the browser here)
export const handleGDriveCallback = async (req, res) => {
  const frontendRedirect = `${clientUrl}/knowledge-base`;

  try {
    const { code, state, error } = req.query;

    if (error || !code || !state) {
      return res.redirect(`${frontendRedirect}?gdrive=error&reason=access_denied`);
    }

    const decodedState = JSON.parse(decryptKey(String(state)));
    const adminId = decodedState?.adminId;
    if (!adminId) {
      return res.redirect(`${frontendRedirect}?gdrive=error&reason=invalid_state`);
    }

    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(String(code));
    oauth2Client.setCredentials(tokens);

    // Fetch the connected Google account email
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    const encryptedAccess = encryptKey(tokens.access_token);
    const encryptedRefresh = tokens.refresh_token
      ? encryptKey(tokens.refresh_token)
      : undefined;

    await prisma.googleDriveCredential.upsert({
      where: { adminId },
      create: {
        adminId,
        googleEmail: userInfo.email || null,
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh || null,
        expiryDate: tokens.expiry_date ? BigInt(tokens.expiry_date) : null,
        status: "CONNECTED",
      },
      update: {
        googleEmail: userInfo.email || null,
        accessToken: encryptedAccess,
        ...(encryptedRefresh && { refreshToken: encryptedRefresh }),
        expiryDate: tokens.expiry_date ? BigInt(tokens.expiry_date) : null,
        status: "CONNECTED",
      },
    });

    return res.redirect(`${frontendRedirect}?gdrive=connected`);
  } catch (err) {
    console.error("[GDrive Callback Error]:", err.message);
    return res.redirect(`${frontendRedirect}?gdrive=error&reason=callback_failed`);
  }
};

// GET /api/gdrive/status
export const getGDriveStatus = async (req, res, next) => {
  try {
    const cred = await prisma.googleDriveCredential.findUnique({
      where: { adminId: req.admin.id },
      select: {
        googleEmail: true,
        status: true,
        updatedAt: true,
      },
    });

    res.json({
      success: true,
      data: {
        connected: cred?.status === "CONNECTED",
        status: cred?.status || "DISCONNECTED",
        googleEmail: cred?.googleEmail || null,
        updatedAt: cred?.updatedAt || null,
      },
    });
  } catch (err) {
    fail(err, next);
  }
};

// DELETE /api/gdrive/disconnect
export const disconnectGDrive = async (req, res, next) => {
  try {
    const cred = await prisma.googleDriveCredential.findUnique({
      where: { adminId: req.admin.id },
    });

    if (!cred) {
      return next(new ApiError(404, "Google Drive is not connected"));
    }

    // Best-effort token revocation with Google
    try {
      const oauth2Client = createOAuth2Client();
      const tokenToRevoke = cred.refreshToken
        ? decryptKey(cred.refreshToken)
        : decryptKey(cred.accessToken);
      if (tokenToRevoke) await oauth2Client.revokeToken(tokenToRevoke);
    } catch {
      // Ignore if token is already expired/revoked on Google's side
    }

    await prisma.googleDriveCredential.delete({
      where: { adminId: req.admin.id },
    });

    res.json({ success: true, message: "Google Drive disconnected" });
  } catch (err) {
    fail(err, next);
  }
};