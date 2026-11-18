import { JourneyNodeType, JourneyStatus } from "@prisma/client";

import ApiError from "../utils/ApiError.js";
import prisma from "../config/prismaClient.js";
import { processJourneyExecution } from "../jobs/journey/journeyProcessor.js";
import { getCustomerAccessFilter } from "./controller.customer.js";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

// Wraps a controller so ApiError / Prisma errors become JSON responses.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof ApiError) {
      return res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
    }
    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "Duplicate record detected. Please refresh and try again.",
      });
    }
    console.error("Journey controller error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Something went wrong." });
  }
};

const isPrivileged = (admin) =>
  admin.isSuperAdmin || admin.role === "administrator";

// Which journeys can this admin see? Privileged = all, others = own only.
const journeyScope = (admin) =>
  isPrivileged(admin) ? {} : { createdById: admin.id };

// Load a journey the admin is allowed to access, or throw 404.
const findJourney = async (id, admin, extra = {}) => {
  const journey = await prisma.journey.findFirst({
    where: { id, ...journeyScope(admin) },
    ...extra,
  });
  if (!journey) throw new ApiError(404, "Journey not found.");
  return journey;
};

// Data the journey engine receives when a customer is enrolled.
// Contact "status" no longer exists, so lead_status maps to LeadTemperature
// and dealClosed is exposed separately for condition nodes.
const buildTriggerData = (customer, enrollmentId) => {
  const [firstName = "", ...rest] = (customer.customerName || "")
    .trim()
    .split(/\s+/);

  return {
    customerId: customer.id,
    customerName: customer.customerName,
    firstName,
    lastName: rest.join(" "),
    email: customer.Email,
    phone: customer.ContactNumber,
    countryCode: customer.CountryCode,
    city: customer.City,
    location: customer.Location,
    campaign: customer.Campaign,
    customerType: customer.CustomerType,
    leadType: customer.LeadType,
    leadTemperature: customer.LeadTemperature,
    dealClosed: customer.DealClosed,
    lead_status: customer.LeadTemperature,
    customFields: customer.CustomerFields,
    enrollmentId,
  };
};

// ─────────────────────────────────────────────────────────────
// Journeys
// ─────────────────────────────────────────────────────────────

export const listJourneys = handle(async (req, res) => {
  const journeys = await prisma.journey.findMany({
    where: journeyScope(req.admin),
    orderBy: { updatedAt: "desc" },
    include: {
      nodes: {
        select: {
          id: true,
          type: true,
          title: true,
          description: true,
          config: true,
        },
      },
      _count: { select: { nodes: true, edges: true, executions: true } },
    },
  });

  res.json({ success: true, data: journeys });
});

export const createJourney = handle(async (req, res) => {
  const body = req.body ?? {};
  const name = body.name?.trim();
  if (!name) throw new ApiError(400, "Journey name is required.");

  const nodes = body.nodes ?? [];
  const edges = body.edges ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new ApiError(400, "Nodes and edges must be arrays.");
  }

  const validTypes = Object.values(JourneyNodeType);
  const nodeIds = new Set();

  for (const node of nodes) {
    if (
      !node.id ||
      !validTypes.includes(node.type) ||
      !node.data?.title ||
      !Number.isFinite(node.position?.x) ||
      !Number.isFinite(node.position?.y)
    ) {
      throw new ApiError(400, "Invalid node data.");
    }
    if (nodeIds.has(node.id)) {
      throw new ApiError(400, "Duplicate node ID found.");
    }
    nodeIds.add(node.id);
  }

  for (const edge of edges) {
    if (!edge.id || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new ApiError(400, "Invalid edge connection.");
    }
  }

  const status = Object.values(JourneyStatus).includes(body.status)
    ? body.status
    : JourneyStatus.draft;

  const journey = await prisma.$transaction(async (tx) => {
    const created = await tx.journey.create({
      data: {
        name,
        description: body.description ?? null,
        status,
        createdById: req.admin.id,
      },
    });

    if (nodes.length) {
      await tx.journeyNode.createMany({
        data: nodes.map((node) => ({
          id: node.id,
          journeyId: created.id,
          type: node.type,
          title: node.data.title,
          description: node.data.description ?? null,
          positionX: node.position.x,
          positionY: node.position.y,
          config: node.data.config ?? undefined,
          actionId: node.data.actionId ?? null,
          category: node.data.category ?? null,
          icon: node.data.icon ?? null,
          color: node.data.color ?? null,
        })),
      });
    }

    if (edges.length) {
      await tx.journeyEdge.createMany({
        data: edges.map((edge) => ({
          id: edge.id,
          journeyId: created.id,
          sourceNodeId: edge.source,
          targetNodeId: edge.target,
          sourceHandle: edge.sourceHandle ?? null,
          targetHandle: edge.targetHandle ?? null,
          label: edge.label ?? null,
          edgeType: edge.type ?? null,
          animated: edge.animated ?? false,
        })),
      });
    }

    return tx.journey.findUnique({
      where: { id: created.id },
      include: { nodes: true, edges: true },
    });
  });

  res.status(201).json({
    success: true,
    message: "Journey created successfully.",
    data: journey,
  });
});

// ─────────────────────────────────────────────────────────────
// Test executions
// ─────────────────────────────────────────────────────────────

export const createTestExecution = handle(async (req, res) => {
  const testData = req.body?.testData ?? {};
  if (typeof testData !== "object" || testData === null || Array.isArray(testData)) {
    throw new ApiError(400, "testData must be a JSON object.");
  }

  const journey = await findJourney(req.params.id, req.admin, {
    include: { nodes: true, edges: true },
  });

  if (journey.nodes.length === 0) {
    throw new ApiError(400, "Cannot test an empty journey.");
  }

  const triggerNode = journey.nodes.find((n) => n.type === "trigger");
  if (!triggerNode) {
    throw new ApiError(400, "Journey must contain a trigger node.");
  }

  const nodeIds = new Set(journey.nodes.map((n) => n.id));
  const badEdge = journey.edges.some(
    (e) => !nodeIds.has(e.sourceNodeId) || !nodeIds.has(e.targetNodeId)
  );
  if (badEdge) throw new ApiError(400, "Journey contains an invalid connection.");

  const execution = await prisma.journeyExecution.create({
    data: {
      journeyId: journey.id,
      customerId: null,
      isTest: true,
      status: "queued",
      currentNodeId: triggerNode.id,
      triggerData: testData,
      logs: {
        create: {
          nodeId: triggerNode.id,
          level: "info",
          message: "Test execution created and queued.",
          metadata: { mode: "test", triggerNodeId: triggerNode.id, testData },
        },
      },
    },
    include: { logs: { orderBy: { createdAt: "asc" } } },
  });

  res.status(201).json({
    success: true,
    message: "Test execution created successfully.",
    data: {
      execution,
      journey: {
        id: journey.id,
        name: journey.name,
        nodeCount: journey.nodes.length,
        edgeCount: journey.edges.length,
        triggerNodeId: triggerNode.id,
      },
    },
  });
});

export const runTestExecution = handle(async (req, res) => {
  const { id: journeyId, executionId } = req.params;

  await findJourney(journeyId, req.admin, { select: { id: true } });

  const execution = await prisma.journeyExecution.findFirst({
    where: { id: executionId, journeyId, isTest: true },
  });
  if (!execution) throw new ApiError(404, "Test execution not found.");

  if (execution.status !== "queued") {
    throw new ApiError(
      409,
      `Execution cannot run because its status is ${execution.status}.`
    );
  }

  // Claim it so it cannot run twice.
  const claimed = await prisma.journeyExecution.updateMany({
    where: { id: executionId, journeyId, isTest: true, status: "queued" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new ApiError(409, "Execution is already running or has been processed.");
  }

  try {
    const result = await processJourneyExecution(executionId, "test");
    res.json({
      success: true,
      message: "Test execution completed successfully.",
      data: result,
    });
  } catch (error) {
    console.error("Journey test execution error:", error);
    res.status(500).json({
      success: false,
      message: "Test execution failed.",
      error: error.message || "Unknown execution error.",
    });
  }
});

export const listExecutions = handle(async (req, res) => {
  const journey = await findJourney(req.params.id, req.admin, {
    select: { id: true, name: true },
  });

  const [executions, total] = await Promise.all([
    prisma.journeyExecution.findMany({
      where: { journeyId: journey.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { logs: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.journeyExecution.count({ where: { journeyId: journey.id } }),
  ]);

  res.json({ success: true, data: { journey, executions, total } });
});

// ─────────────────────────────────────────────────────────────
// Enrollments
// ─────────────────────────────────────────────────────────────

export const enrollCustomers = handle(async (req, res) => {
  const body = req.body ?? {};
  const source = body.source?.trim() || "manual";

  const customerIds = [
    ...new Set(
      [...(body.customerIds ?? []), ...(body.customerId ? [body.customerId] : [])]
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ];

  if (customerIds.length === 0) {
    throw new ApiError(400, "Please provide at least one valid customer ID.");
  }
  if (customerIds.length > 500) {
    throw new ApiError(400, "Maximum 500 customers can be enrolled at a time.");
  }

  const journey = await findJourney(req.params.id, req.admin, {
    select: {
      id: true,
      name: true,
      status: true,
      nodes: {
        where: { type: "trigger" },
        select: { id: true, title: true },
        take: 1,
      },
    },
  });

  if (journey.status !== "active") {
    throw new ApiError(400, "Only active journeys can accept enrollments.");
  }
  const triggerNode = journey.nodes[0];
  if (!triggerNode) throw new ApiError(400, "Journey does not have a trigger node.");

  // Only customers this admin is allowed to access.
  const customers = await prisma.customer.findMany({
    where: {
      AND: [
        { id: { in: customerIds } },
        await getCustomerAccessFilter(req.admin),
      ],
    },
  });

  const foundIds = new Set(customers.map((c) => c.id));
  const invalidCustomerIds = customerIds.filter((id) => !foundIds.has(id));
  if (invalidCustomerIds.length) {
    return res.status(404).json({
      success: false,
      message: "Some customers were not found or are not accessible.",
      invalidCustomerIds,
    });
  }

  // Skip customers already enrolled in this journey.
  const existing = await prisma.journeyEnrollment.findMany({
    where: { journeyId: journey.id, customerId: { in: customerIds } },
    select: { customerId: true },
  });
  const enrolledSet = new Set(existing.map((e) => e.customerId));
  const duplicateCustomerIds = customerIds.filter((id) => enrolledSet.has(id));
  const newCustomers = customers.filter((c) => !enrolledSet.has(c.id));

  const records = await prisma.$transaction(
    async (tx) => {
      const out = [];

      for (const customer of newCustomers) {
        const enrollment = await tx.journeyEnrollment.create({
          data: {
            journeyId: journey.id,
            customerId: customer.id,
            source,
            status: "active",
          },
        });

        const execution = await tx.journeyExecution.create({
          data: {
            journeyId: journey.id,
            customerId: customer.id,
            status: "queued",
            isTest: false,
            currentNodeId: triggerNode.id,
            triggerData: buildTriggerData(customer, enrollment.id),
            logs: {
              create: {
                nodeId: triggerNode.id,
                level: "info",
                message: "Customer enrolled. Journey execution created and queued.",
                metadata: { enrollmentId: enrollment.id, source },
              },
            },
          },
        });

        const updated = await tx.journeyEnrollment.update({
          where: { id: enrollment.id },
          data: { executionId: execution.id },
        });

        out.push({ enrollment: updated, execution });
      }

      return out;
    },
    { maxWait: 10000, timeout: 60000 }
  );

  res.status(201).json({
    success: true,
    message: "Customer enrollment and execution creation completed.",
    data: {
      journey: { id: journey.id, name: journey.name },
      triggerNode,
      summary: {
        requested: customerIds.length,
        enrolled: records.length,
        executionsCreated: records.length,
        alreadyEnrolled: duplicateCustomerIds.length,
      },
      duplicateCustomerIds,
      enrollments: records.map(({ enrollment, execution }) => ({
        id: enrollment.id,
        customerId: enrollment.customerId,
        status: enrollment.status,
        source: enrollment.source,
        enrolledAt: enrollment.enrolledAt,
        executionId: execution.id,
        executionStatus: execution.status,
      })),
    },
  });
});

export const listEnrollments = handle(async (req, res) => {
  const journey = await findJourney(req.params.id, req.admin, {
    select: { id: true, name: true, status: true },
  });

  const status = req.query.status;
  const search = String(req.query.search ?? "").trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  if (status && !["active", "completed", "failed", "cancelled"].includes(status)) {
    throw new ApiError(400, "Invalid enrollment status.");
  }

  // Only enrollments of customers this admin may access.
  const access = await getCustomerAccessFilter(req.admin);

  const where = {
    journeyId: journey.id,
    ...(status ? { status } : {}),
    customer: {
      AND: [
        access,
        ...(search
          ? [
              {
                OR: [
                  { customerName: { contains: search } },
                  { Email: { contains: search } },
                  { ContactNumber: { contains: search } },
                  { City: { contains: search } },
                  { Campaign: { contains: search } },
                ],
              },
            ]
          : []),
      ],
    },
  };

  const [enrollments, total, statusCounts] = await Promise.all([
    prisma.journeyEnrollment.findMany({
      where,
      include: {
        customer: {
          select: {
            id: true,
            customerName: true,
            Email: true,
            ContactNumber: true,
            CountryCode: true,
            City: true,
            Campaign: true,
            LeadTemperature: true,
            DealClosed: true,
          },
        },
      },
      orderBy: { enrolledAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.journeyEnrollment.count({ where }),
    prisma.journeyEnrollment.groupBy({
      by: ["status"],
      where: { journeyId: journey.id, customer: access },
      _count: { _all: true },
    }),
  ]);

  const counts = { active: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of statusCounts) counts[item.status] = item._count._all;

  res.json({
    success: true,
    data: {
      journey,
      summary: { total: Object.values(counts).reduce((a, b) => a + b, 0), ...counts },
      enrollments,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    },
  });
});

export const getEnrollment = handle(async (req, res) => {
  const { id: journeyId, enrollmentId } = req.params;
  await findJourney(journeyId, req.admin, { select: { id: true } });

  const enrollment = await prisma.journeyEnrollment.findFirst({
    where: {
      id: enrollmentId,
      journeyId,
      customer: await getCustomerAccessFilter(req.admin),
    },
    include: {
      customer: true,
      journey: { select: { id: true, name: true, status: true } },
    },
  });
  if (!enrollment) throw new ApiError(404, "Enrollment not found.");

  res.json({ success: true, data: enrollment });
});

export const cancelEnrollment = handle(async (req, res) => {
  const { id: journeyId, enrollmentId } = req.params;

  if (req.body?.status !== "cancelled") {
    throw new ApiError(400, "Only cancellation is supported at this stage.");
  }

  await findJourney(journeyId, req.admin, { select: { id: true } });

  const enrollment = await prisma.journeyEnrollment.findFirst({
    where: { id: enrollmentId, journeyId },
  });
  if (!enrollment) throw new ApiError(404, "Enrollment not found.");
  if (enrollment.status !== "active") {
    throw new ApiError(400, "Only active enrollments can be cancelled.");
  }

  const [updated] = await prisma.$transaction([
    prisma.journeyEnrollment.update({
      where: { id: enrollmentId },
      data: { status: "cancelled", exitedAt: new Date() },
    }),
    // Also stop the execution if the worker has not started it yet.
    prisma.journeyExecution.updateMany({
      where: { id: enrollment.executionId ?? "", status: "queued" },
      data: { status: "cancelled", completedAt: new Date() },
    }),
  ]);

  res.json({
    success: true,
    message: "Enrollment cancelled successfully.",
    data: updated,
  });
});

// ─────────────────────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────────────────────

const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);

export const getAnalytics = handle(async (req, res) => {
  const journeys = await prisma.journey.findMany({
    where: journeyScope(req.admin),
    select: { id: true, name: true, status: true },
  });
  const journeyIds = journeys.map((j) => j.id);

  const trendStart = new Date();
  trendStart.setUTCHours(0, 0, 0, 0);
  trendStart.setUTCDate(trendStart.getUTCDate() - 13);

  // Two queries: counts grouped in the DB + only the last 14 days for the trend.
  const [grouped, recent] = await Promise.all([
    prisma.journeyExecution.groupBy({
      by: ["journeyId", "status", "isTest"],
      where: { journeyId: { in: journeyIds } },
      _count: { _all: true },
    }),
    prisma.journeyExecution.findMany({
      where: { journeyId: { in: journeyIds }, createdAt: { gte: trendStart } },
      select: { status: true, isTest: true, createdAt: true },
    }),
  ]);

  const real = { total: 0, completed: 0, failed: 0, running: 0, queued: 0, cancelled: 0 };
  let testTotal = 0;
  const perJourney = new Map(
    journeys.map((j) => [j.id, { total: 0, completed: 0, failed: 0 }])
  );

  for (const row of grouped) {
    const n = row._count._all;
    if (row.isTest) {
      testTotal += n;
      continue;
    }
    real.total += n;
    real[row.status] += n;

    const j = perJourney.get(row.journeyId);
    j.total += n;
    if (row.status === "completed") j.completed += n;
    if (row.status === "failed") j.failed += n;
  }

  const trend = Array.from({ length: 14 }, (_, i) => {
    const start = new Date(trendStart);
    start.setUTCDate(start.getUTCDate() + i);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const day = recent.filter((e) => e.createdAt >= start && e.createdAt < end);
    const dayReal = day.filter((e) => !e.isTest);

    return {
      date: start.toISOString().slice(0, 10),
      label: start.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        timeZone: "UTC",
      }),
      real: dayReal.length,
      test: day.length - dayReal.length,
      completed: dayReal.filter((e) => e.status === "completed").length,
      failed: dayReal.filter((e) => e.status === "failed").length,
    };
  });

  const journeyPerformance = journeys
    .map((j) => {
      const s = perJourney.get(j.id);
      return {
        id: j.id,
        name: j.name,
        status: j.status,
        totalExecutions: s.total,
        completed: s.completed,
        failed: s.failed,
        successRate: pct(s.completed, s.total),
      };
    })
    .sort((a, b) => b.totalExecutions - a.totalExecutions);

  res.json({
    success: true,
    data: {
      summary: {
        totalExecutions: real.total,
        testExecutions: testTotal,
        completed: real.completed,
        failed: real.failed,
        running: real.running,
        queued: real.queued,
        cancelled: real.cancelled,
        successRate: pct(real.completed, real.total),
        activeJourneys: journeys.filter((j) => j.status === "active").length,
        totalJourneys: journeys.length,
      },
      modeBreakdown: { real: real.total, test: testTotal },
      trend,
      journeys: journeyPerformance,
      generatedAt: new Date().toISOString(),
    },
  });
});