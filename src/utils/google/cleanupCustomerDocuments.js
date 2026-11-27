
import prisma from "../../config/prismaClient.js";
import { deleteCustomersVectors } from "../rag/qdrantClient.js";
import { getDriveClientForAdmin } from "./googleDriveClient.js";

/**
 * Deletes all Google Drive files and Qdrant vectors belonging to one or more customers.
 * Must be called BEFORE prisma.customer.delete / deleteMany (before Cascade removes DB rows).
 * @param {string | string[]} customerIds
 */
export async function cleanupCustomerDocuments(customerIds) {
  const ids = (Array.isArray(customerIds) ? customerIds : [customerIds]).filter(Boolean);
  if (ids.length === 0) return;

  // 1. Fetch all Drive documents for these customers before Cascade deletes the rows
  const docs = await prisma.customerDocument.findMany({
    where: { customerId: { in: ids } },
    select: { driveFileId: true, uploadedById: true },
  });

  // 2. Best-effort delete from Google Drive (grouped by uploader to reuse Drive clients)
  if (docs.length > 0) {
    const filesByUploader = new Map();
    for (const d of docs) {
      if (!filesByUploader.has(d.uploadedById)) {
        filesByUploader.set(d.uploadedById, []);
      }
      filesByUploader.get(d.uploadedById).push(d.driveFileId);
    }

    await Promise.allSettled(
      Array.from(filesByUploader.entries()).map(async ([uploaderId, fileIds]) => {
        const { drive } = await getDriveClientForAdmin(uploaderId);
        await Promise.allSettled(
          fileIds.map((fileId) => drive.files.delete({ fileId }))
        );
      })
    );
  }

  // 3. Delete all Qdrant vectors linked to these customers
  await deleteCustomersVectors(ids).catch((err) =>
    console.warn("[Qdrant Customer Cleanup Warning]:", err.message)
  );
}