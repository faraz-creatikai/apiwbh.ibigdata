// controllers/controller.googleDrive.js
import { google } from "googleapis";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { encryptKey, decryptKey } from "../utils/cryptoHelper.js";
import { createOAuth2Client, GDRIVE_SCOPES, getDriveClientForAdmin } from "../utils/google/googleDriveClient.js";
import { clientUrl } from "../config/cors-origins.js";

import { Readable } from "stream";
import { getCustomerAccessFilter } from "./controller.customer.js";


const seesAll = (a) => a.isSuperAdmin || a.role === "administrator";

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
















// documents controller


/**
 * Helper: Finds or creates a dedicated "CRM_Documents" folder in the admin's Google Drive
 * so uploaded customer files stay organized instead of cluttering their Drive root.
 */
async function getOrCreateCrmFolder(drive) {
  const folderName = "CRM_Documents";
  const listRes = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (listRes.data.files?.length) {
    return listRes.data.files[0].id;
  }

  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  return createRes.data.id;
}

// POST /api/gdrive/documents
// Expects multipart/form-data with field "file" and body field "customerId"
export const uploadCustomerDocument = async (req, res, next) => {
  try {
    const file = req.file;
    const { customerId } = req.body;

    if (!file) {
      return next(new ApiError(400, "Please upload a file"));
    }
    if (!customerId) {
      return next(new ApiError(400, "customerId is required"));
    }

    // Verify the customer exists and this admin has access to them
    const access = await getCustomerAccessFilter(req.admin);
    const customer = await prisma.customer.findFirst({
      where: { AND: [access, { id: customerId }] },
      select: { id: true, customerName: true },
    });

    if (!customer) {
      return next(new ApiError(404, "Customer not found or access denied"));
    }

    // Get authenticated Google Drive client for the current admin
    const { drive } = await getDriveClientForAdmin(req.admin.id);
    const folderId = await getOrCreateCrmFolder(drive);

    // Stream buffer directly to Google Drive (no local disk writes)
    const driveRes = await drive.files.create({
      requestBody: {
        name: file.originalname,
        parents: [folderId],
      },
      media: {
        mimeType: file.mimetype,
        body: Readable.from(file.buffer),
      },
      fields: "id, name, mimeType, size, webViewLink, webContentLink",
    });

    const uploaded = driveRes.data;

    const doc = await prisma.customerDocument.create({
      data: {
        customerId: customer.id,
        uploadedById: req.admin.id,
        fileName: uploaded.name || file.originalname,
        mimeType: uploaded.mimeType || file.mimetype,
        fileSize: uploaded.size ? Number(uploaded.size) : file.size,
        driveFileId: uploaded.id,
        webViewLink: uploaded.webViewLink || null,
        webContentLink: uploaded.webContentLink || null,
        ragStatus: "PENDING",
      },
      include: {
        customer: { select: { id: true, customerName: true, ContactNumber: true } },
        uploadedBy: { select: { id: true, name: true } },
      },
    });

    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    fail(err, next);
  }
};

// GET /api/gdrive/documents?customerId=&search=&page=&limit=
export const getCustomerDocuments = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const customerId = String(req.query.customerId || "").trim();
    const search = String(req.query.search || "").trim();

    const where = {
      // Non-admins only see documents they uploaded or for customers they can access
      ...(!seesAll(req.admin) && { uploadedById: req.admin.id }),
      ...(customerId && { customerId }),
      ...(search && {
        OR: [
          { fileName: { contains: search } },
          { customer: { customerName: { contains: search } } },
        ],
      }),
    };

    const [total, data] = await Promise.all([
      prisma.customerDocument.count({ where }),
      prisma.customerDocument.findMany({
        where,
        include: {
          customer: { select: { id: true, customerName: true, ContactNumber: true } },
          uploadedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({
      success: true,
      total,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      data,
    });
  } catch (err) {
    fail(err, next);
  }
};

// DELETE /api/gdrive/documents/:id
export const deleteCustomerDocument = async (req, res, next) => {
  try {
    const doc = await prisma.customerDocument.findFirst({
      where: {
        id: req.params.id,
        ...(!seesAll(req.admin) && { uploadedById: req.admin.id }),
      },
    });

    if (!doc) {
      return next(new ApiError(404, "Document not found"));
    }

    // Best-effort delete from the Google Drive account that owns the file
    try {
      const { drive } = await getDriveClientForAdmin(doc.uploadedById);
      await drive.files.delete({ fileId: doc.driveFileId });
    } catch (driveErr) {
      // If the file was already removed in Drive or token was revoked, still clean up DB
      console.warn("[GDrive] Could not delete file from Drive:", driveErr.message);
    }

    await prisma.customerDocument.delete({ where: { id: doc.id } });

    res.json({ success: true, message: "Document deleted" });
  } catch (err) {
    fail(err, next);
  }
};