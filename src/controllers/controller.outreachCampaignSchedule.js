// controllers/controller.outreachCampaignSchedule.js
//
// Alarm-clock style schedules for a campaign + the background worker that fires them.
//
//  - A campaign can have several alarms. Each has a time, repeat days and an on/off switch.
//  - days = [1,2,3,4,5] repeats on those weekdays (0 = Sunday ... 6 = Saturday). days = [] = once, then it switches itself off.
//  - Times are in the alarm's own time zone (the UI should send the browser's: Intl.DateTimeFormat().resolvedOptions().timeZone).
//  - The worker looks every 30 seconds, so an alarm fires within ~30 seconds of its time.
//  - It runs the campaign with the same startCampaignRun() the Run button uses, from the campaign owner's accounts.
//
// CHANGES IN THIS VERSION (search for "FIX"):
//  FIX 1  fire() saves the run it started in schedule.lastRunId (needs the new column, see the Prisma note below).
//  FIX 2  listSchedules attaches `lastRun` (real status, summary, tracking) read from the run table with the SAME
//         trackingForRuns() the run reports use, so the alarm never stays stuck on "started".
//  FIX 3  fire(): a deleted campaign now records a status instead of silently returning.
//  FIX 4  days are sorted numerically.
//
// PRISMA: add to model OutreachCampaignSchedule   ->   lastRunId String?   (then run the migration)

import { z } from "zod";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import { ownedWhere } from "./controller.outreachCampaign.js";
import { startCampaignRun, trackingForRuns } from "./controller.outreachCampaignRun.js";

/* ================= SETTINGS ================= */

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || "Asia/Kolkata";
const MAX_SCHEDULES_PER_CAMPAIGN = 10;
const CHECK_MS = 30_000; // how often the worker looks for alarms that are due
const MISSED_MS = 60 * 60_000; // an alarm more than 1 hour late (server was down) is skipped, not run

/* ================= TIME MATH (no extra library) ================= */

/** Wall-clock parts of an instant in a time zone. */
const partsIn = (ms, tz) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
};

/** How far ahead of UTC the zone is at that instant. */
const offsetMs = (ms, tz) => {
  const p = partsIn(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

/** "09:30 on this calendar date in this zone" -> UTC milliseconds. m is 1-12. */
const localToUtc = (y, m, d, h, mi, tz) => {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz); // second pass fixes the daylight-saving edge
};

/** The next time (after `fromMs`) this alarm should ring, as a Date, or null. */
export const computeNextRun = (time, days, tz, fromMs = Date.now()) => {
  const [h, mi] = time.split(":").map(Number);
  const today = partsIn(fromMs, tz);
  for (let i = 0; i < 8; i++) {
    const cal = new Date(Date.UTC(today.y, today.m - 1, today.d + i)); // plain calendar arithmetic
    if (days.length && !days.includes(cal.getUTCDay())) continue;
    const at = localToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), h, mi, tz);
    if (at > fromMs) return new Date(at);
  }
  return null;
};

/* ================= VALIDATION ================= */

const schema = z.object({
  label: z.string().trim().max(60).nullish(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must look like 09:30 (24 hour)"),
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  timezone: z.string().trim().min(1).max(64).nullish(),
  enabled: z.boolean().optional(),
});

/** Validates the body and returns the data to save (including the computed nextRunAt). */
const parse = (body) => {
  const parsed = schema.safeParse(body || {});
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => i.message).join(", "));
  const d = parsed.data;

  const tz = d.timezone || DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw new ApiError(400, "Unknown time zone"); }

  const days = [...new Set(d.days)].sort((a, b) => a - b); // FIX 4
  const enabled = d.enabled ?? true;
  return {
    label: d.label || "",
    time: d.time,
    days,
    timezone: tz,
    enabled,
    nextRunAt: enabled ? computeNextRun(d.time, days, tz) : null,
  };
};

const fail = (err, next) => next(err instanceof ApiError ? err : new ApiError(500, err.message));
const ownedCampaign = (req) =>
  prisma.outreachCampaign.findFirst({ where: { id: req.params.id, ...ownedWhere(req.admin) }, select: { id: true } });

const SELECT = {
  id: true, campaignId: true, label: true, time: true, days: true, timezone: true, enabled: true,
  nextRunAt: true, lastRunAt: true, lastRunStatus: true, lastRunId: true, lastError: true, createdAt: true,
};

/* ================= LAST RUN INFO (FIX 2) ================= */

/** Adds `lastRun` to each schedule: the real run status + summary + tracking (same numbers as the run report). */
const withLastRun = async (schedules) => {
  const ids = [...new Set(schedules.map((s) => s.lastRunId).filter(Boolean))];
  if (!ids.length) return schedules.map((s) => ({ ...s, lastRun: null }));

  const runs = await prisma.outreachCampaignRun.findMany({ where: { id: { in: ids } } });
  const tmap = await trackingForRuns(runs);
  const byId = new Map(
    runs.map((r) => [
      r.id,
      {
        id: r.id, trigger: r.trigger, status: r.status, totalCustomers: r.totalCustomers,
        summary: r.summary, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt,
        tracking: tmap.get(r.id) || {},
      },
    ])
  );
  return schedules.map((s) => ({ ...s, lastRun: byId.get(s.lastRunId) ?? null }));
};

/* ================= HANDLERS ================= */

// GET /campaigns/:id/schedules
export const listSchedules = async (req, res, next) => {
  try {
    const campaign = await ownedCampaign(req);
    if (!campaign) return next(new ApiError(404, "Campaign not found"));
    const data = await prisma.outreachCampaignSchedule.findMany({
      where: { campaignId: campaign.id }, select: SELECT, orderBy: [{ time: "asc" }, { createdAt: "asc" }],
    });
    res.json({ success: true, data: await withLastRun(data) });
  } catch (err) {
    fail(err, next);
  }
};

// POST /campaigns/:id/schedules   { label?, time: "09:30", days: [1,2,3,4,5], timezone?, enabled? }
export const createSchedule = async (req, res, next) => {
  try {
    const campaign = await ownedCampaign(req);
    if (!campaign) return next(new ApiError(404, "Campaign not found"));

    const count = await prisma.outreachCampaignSchedule.count({ where: { campaignId: campaign.id } });
    if (count >= MAX_SCHEDULES_PER_CAMPAIGN) {
      return next(new ApiError(400, `A campaign can have at most ${MAX_SCHEDULES_PER_CAMPAIGN} schedules`));
    }

    const data = parse(req.body);
    const created = await prisma.outreachCampaignSchedule.create({ data: { ...data, campaignId: campaign.id }, select: SELECT });
    res.status(201).json({ success: true, data: { ...created, lastRun: null } });
  } catch (err) {
    fail(err, next);
  }
};

// PUT /campaigns/:id/schedules/:scheduleId   (send only what changed; { enabled: false } is the on/off switch)
export const updateSchedule = async (req, res, next) => {
  try {
    const campaign = await ownedCampaign(req);
    if (!campaign) return next(new ApiError(404, "Campaign not found"));
    const existing = await prisma.outreachCampaignSchedule.findFirst({ where: { id: req.params.scheduleId, campaignId: campaign.id } });
    if (!existing) return next(new ApiError(404, "Schedule not found"));

    const data = parse({
      label: existing.label, time: existing.time, days: existing.days, timezone: existing.timezone, enabled: existing.enabled,
      ...req.body,
    });
    const updated = await prisma.outreachCampaignSchedule.update({ where: { id: existing.id }, data, select: SELECT });
    res.json({ success: true, data: (await withLastRun([updated]))[0] });
  } catch (err) {
    fail(err, next);
  }
};

// DELETE /campaigns/:id/schedules/:scheduleId
export const deleteSchedule = async (req, res, next) => {
  try {
    const campaign = await ownedCampaign(req);
    if (!campaign) return next(new ApiError(404, "Campaign not found"));
    const r = await prisma.outreachCampaignSchedule.deleteMany({ where: { id: req.params.scheduleId, campaignId: campaign.id } });
    if (!r.count) return next(new ApiError(404, "Schedule not found"));
    res.json({ success: true, message: "Schedule deleted" });
  } catch (err) {
    fail(err, next);
  }
};

/* ================= THE WORKER ================= */

const fire = async (s, now) => {
  const days = Array.isArray(s.days) ? s.days : [];
  const repeats = days.length > 0;
  const next = repeats ? computeNextRun(s.time, days, s.timezone, now.getTime()) : null;

  // Claim it: move nextRunAt away from the value we read. If two servers race, only one update matches.
  const claim = await prisma.outreachCampaignSchedule.updateMany({
    where: { id: s.id, enabled: true, nextRunAt: s.nextRunAt },
    data: { nextRunAt: next, enabled: repeats, lastRunAt: now },
  });
  if (claim.count !== 1) return;

  let status = "started";
  let error = null;
  let runId = null;
  try {
    const campaign = await prisma.outreachCampaign.findUnique({ where: { id: s.campaignId } });
    if (!campaign) {
      status = "failed"; // FIX 3
      error = "Campaign no longer exists";
    } else if (now.getTime() - s.nextRunAt.getTime() > MISSED_MS) {
      status = "missed"; // server was down for too long: don't send late
    } else if (campaign.status === "paused") {
      status = "skipped_paused";
    } else {
      const { run } = await startCampaignRun(campaign, { trigger: "scheduled", scheduleId: s.id });
      runId = run.id; // FIX 1
    }
  } catch (err) {
    status = /already running/i.test(err.message) ? "skipped_running" : "failed";
    error = String(err.message).slice(0, 500);
  }

  // lastRunId is only overwritten when a run really started, so a skipped alarm keeps pointing at the last real report
  await prisma.outreachCampaignSchedule
    .update({ where: { id: s.id }, data: { lastRunStatus: status, lastError: error, ...(runId && { lastRunId: runId }) } })
    .catch(() => {});
};

/** Call once at server start (next to startCampaignRunMonitor). */
export const startCampaignScheduler = () => {
  const tick = async () => {
    try {
      const now = new Date();
      const due = await prisma.outreachCampaignSchedule.findMany({
        where: { enabled: true, nextRunAt: { lte: now } },
        orderBy: { nextRunAt: "asc" },
        take: 20,
      });
      for (const s of due) await fire(s, now);
    } catch (e) {
      console.error("campaign scheduler tick failed:", e.message);
    }
    setTimeout(tick, CHECK_MS).unref();
  };
  setTimeout(tick, 20_000).unref();
};