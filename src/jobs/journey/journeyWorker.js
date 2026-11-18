import prisma from "../../config/prismaClient.js";
import { processJourneyExecution } from "./journeyProcessor.js";

const BATCH_SIZE = 10;
const MAX_RETRIES = 3;
const STALE_LOCK_MINUTES = 10;
const RETRY_DELAYS_MINUTES = [1, 5, 15];

const minutes = (n) => n * 60 * 1000;

const addLog = (executionId, level, message, metadata) =>
  prisma.executionLog.create({
    data: { executionId, level, message, metadata },
  });

const syncEnrollment = (executionId, data) =>
  prisma.journeyEnrollment.updateMany({ where: { executionId }, data });

const REACTIVATE = { status: "active", completedAt: null, exitedAt: null };

/**
 * POST /api/journeys/worker/run
 * Called by an external cron / scheduler. Protected by CRON_SECRET, not by
 * admin login, so it must be registered BEFORE protectRoute in the router.
 */
export const runJourneyWorker = async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      return res
        .status(500)
        .json({ success: false, message: "CRON_SECRET is not configured." });
    }
    if (req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const now = new Date();
    const staleBefore = new Date(now.getTime() - minutes(STALE_LOCK_MINUTES));
    const stale = { status: "running", isTest: false, lockedAt: { lt: staleBefore } };

    let recovered = 0;
    let permanentlyFailed = 0;
    let processed = 0;
    let failed = 0;
    let retried = 0;
    let skipped = 0;

    // 1. Stale locks that can still be retried → back to the queue.
    const retryable = await prisma.journeyExecution.findMany({
      where: { ...stale, retryCount: { lt: MAX_RETRIES } },
      select: { id: true, retryCount: true },
      take: BATCH_SIZE,
    });

    for (const item of retryable) {
      const result = await prisma.journeyExecution.updateMany({
        where: { id: item.id, ...stale, retryCount: item.retryCount },
        data: {
          status: "queued",
          retryCount: { increment: 1 },
          nextRunAt: now,
          lockedAt: null,
          startedAt: null,
          completedAt: null,
          errorMessage: "Recovered after a stale worker lock.",
        },
      });
      if (result.count === 0) continue;

      recovered++;
      await syncEnrollment(item.id, REACTIVATE);
      await addLog(item.id, "warning", "Execution recovered after a stale worker lock.", {
        retryCount: item.retryCount + 1,
        recoveredAt: now.toISOString(),
      });
    }

    // 2. Stale locks that ran out of retries → permanently failed.
    const exhausted = await prisma.journeyExecution.findMany({
      where: { ...stale, retryCount: { gte: MAX_RETRIES } },
      select: { id: true },
      take: BATCH_SIZE,
    });

    for (const item of exhausted) {
      const result = await prisma.journeyExecution.updateMany({
        where: { id: item.id, ...stale, retryCount: { gte: MAX_RETRIES } },
        data: {
          status: "failed",
          lockedAt: null,
          completedAt: now,
          errorMessage: "Execution stopped after maximum retry attempts.",
        },
      });
      if (result.count === 0) continue;

      permanentlyFailed++;
      await syncEnrollment(item.id, { status: "failed", exitedAt: now });
      await addLog(
        item.id,
        "error",
        "Maximum retry attempts reached. Execution permanently failed."
      );
    }

    // 3. Queued executions that are due.
    const due = {
      status: "queued",
      isTest: false,
      lockedAt: null,
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    };

    const queued = await prisma.journeyExecution.findMany({
      where: due,
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    for (const item of queued) {
      const lockedAt = new Date();

      // Claim it so two workers never run the same execution.
      const claim = await prisma.journeyExecution.updateMany({
        where: { id: item.id, ...due },
        data: { status: "running", lockedAt, startedAt: lockedAt },
      });
      if (claim.count === 0) {
        skipped++;
        continue;
      }

      try {
        await processJourneyExecution(item.id, "live");
        processed++;
      } catch (error) {
        failed++;
        console.error(`Journey execution failed: ${item.id}`, error);

        // The processor marks the execution "failed"; retry it with backoff.
        const current = await prisma.journeyExecution.findUnique({
          where: { id: item.id },
          select: { status: true, retryCount: true },
        });

        if (current?.status === "failed" && current.retryCount < MAX_RETRIES) {
          const delay = RETRY_DELAYS_MINUTES[current.retryCount] ?? 15;
          const nextRunAt = new Date(Date.now() + minutes(delay));

          const retry = await prisma.journeyExecution.updateMany({
            where: { id: item.id, status: "failed", retryCount: current.retryCount },
            data: {
              status: "queued",
              retryCount: { increment: 1 },
              nextRunAt,
              completedAt: null,
              startedAt: null,
              errorMessage: null,
            },
          });

          if (retry.count > 0) {
            retried++;
            await syncEnrollment(item.id, REACTIVATE);
            await addLog(
              item.id,
              "warning",
              `Execution scheduled for retry ${current.retryCount + 1} of ${MAX_RETRIES}.`,
              {
                retryCount: current.retryCount + 1,
                nextRunAt: nextRunAt.toISOString(),
                retryDelayMinutes: delay,
              }
            );
          }
        }
      } finally {
        // Release this worker's lock.
        await prisma.journeyExecution.updateMany({
          where: { id: item.id, lockedAt },
          data: { lockedAt: null },
        });
      }
    }

    res.json({
      success: true,
      message: "Journey worker completed.",
      data: {
        found: queued.length,
        processed,
        failed,
        retried,
        recovered,
        permanentlyFailed,
        skipped,
      },
    });
  } catch (error) {
    console.error("Journey worker error:", error);
    res.status(500).json({ success: false, message: "Journey worker failed." });
  }
};