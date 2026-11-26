// utils/googleDriveClient.js
import { google } from "googleapis";


import prisma from "../../config/prismaClient.js";
import ApiError from "../ApiError.js";
import { decryptKey, encryptKey } from "../cryptoHelper.js";
import { serverUrl } from "../../config/cors-origins.js";

export const GDRIVE_SCOPES = [
    "https://www.googleapis.com/auth/drive.file", // Upload & manage files created by this CRM
    "https://www.googleapis.com/auth/userinfo.email", // Fetch connected Google email
];

export const createOAuth2Client = () => {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        serverUrl + "/api/gdrive/callback"
    );
};

/**
 * Returns an authenticated Google Drive v3 client for a specific admin.
 * Automatically persists refreshed access tokens back to MySQL.
 */
export async function getDriveClientForAdmin(adminId) {
    const cred = await prisma.googleDriveCredential.findUnique({
        where: { adminId },
    });

    if (!cred || cred.status !== "CONNECTED") {
        throw new ApiError(400, "Google Drive is not connected for this account");
    }

    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials({
        access_token: decryptKey(cred.accessToken),
        refresh_token: cred.refreshToken ? decryptKey(cred.refreshToken) : undefined,
        expiry_date: cred.expiryDate ? Number(cred.expiryDate) : undefined,
    });

    // Persist refreshed tokens automatically when googleapis renews them
    oauth2Client.on("tokens", async (tokens) => {
        try {
            await prisma.googleDriveCredential.update({
                where: { adminId },
                data: {
                    ...(tokens.access_token && { accessToken: encryptKey(tokens.access_token) }),
                    ...(tokens.refresh_token && { refreshToken: encryptKey(tokens.refresh_token) }),
                    ...(tokens.expiry_date && { expiryDate: BigInt(tokens.expiry_date) }),
                },
            });
        } catch (err) {
            console.error("[GDrive] Failed to persist refreshed tokens:", err.message);
        }
    });

    const drive = google.drive({ version: "v3", auth: oauth2Client });
    return { drive, oauth2Client };
}