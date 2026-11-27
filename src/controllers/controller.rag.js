// controllers/controller.googleDrive.js
import { google } from "googleapis";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { encryptKey, decryptKey } from "../utils/cryptoHelper.js";
import { createOAuth2Client, GDRIVE_SCOPES, getDriveClientForAdmin } from "../utils/google/googleDriveClient.js";
import { clientName, clientUrl } from "../config/cors-origins.js";

import { Readable } from "stream";
import { getCustomerAccessFilter } from "./controller.customer.js";
import fs from "fs";
import { askKnowledgeBase, indexDocument } from "../utils/rag/ragService.js";
import { deleteDocumentVectors } from "../utils/rag/qdrantClient.js";


const seesAll = (a) => a.isSuperAdmin || a.role === "administrator";

const fail = (err, next) =>
    next(err instanceof ApiError ? err : new ApiError(500, err.message));


//RAG

// POST /api/gdrive/documents/:id/reindex
export const reindexCustomerDocument = async (req, res, next) => {
  try {
    const doc = await prisma.customerDocument.findFirst({
      where: {
        id: req.params.id,
        ...(!seesAll(req.admin) && { uploadedById: req.admin.id }),
      },
      select: { id: true },
    });

    if (!doc) {
      return next(new ApiError(404, "Document not found"));
    }

    const result = await indexDocument(doc.id);
    res.json({
      success: true,
      message: `Document indexed (${result.chunksIndexed} chunks)`,
      data: result,
    });
  } catch (err) {
    fail(err, next);
  }
};

// POST /api/gdrive/rag/ask
export const askCrmAssistant = async (req, res, next) => {
  try {
    const query = String(req.body?.query || "").trim();
    const customerId = req.body?.customerId ? String(req.body.customerId).trim() : undefined;
    const category = req.body?.category ? String(req.body.category).trim() : undefined;
    const history = Array.isArray(req.body?.history) ? req.body.history : [];

    if (!query) {
      return next(new ApiError(400, "Question (query) is required"));
    }

    const result = await askKnowledgeBase({
      admin: req.admin,
      query,
      customerId,
      category,
      history,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    fail(err, next);
  }
};