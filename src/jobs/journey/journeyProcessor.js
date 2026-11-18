import prisma from "../../config/prismaClient.js";


const MAX_STEPS = 100;

const UNIT_MS = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

const toObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};

const isEmpty = (v) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

const toNumbers = (actual, expected, operator) => {
  const a = Number(actual);
  const e = Number(expected);
  if (isEmpty(actual) || isEmpty(expected) || !Number.isFinite(a) || !Number.isFinite(e)) {
    throw new Error(`Invalid numeric values for ${operator} condition.`);
  }
  return [a, e];
};

// config = { conditionField, operator, value }, data = execution.triggerData
// Fields available for customers: leadTemperature / lead_status, dealClosed,
// city, campaign, customerType, leadType, email, phone, customerName, ...
const evaluateCondition = (config, data) => {
  const field = String(config.conditionField ?? "").trim();
  const operator = String(config.operator ?? "equals").trim();
  if (!field) throw new Error("Condition field is required.");

  const actual = data[field];
  const expected = config.value;
  const a = String(actual ?? "").trim().toLowerCase();
  const e = String(expected ?? "").trim().toLowerCase();

  switch (operator) {
    case "equals":
      return !isEmpty(actual) && a === e;
    case "not_equals":
      return !isEmpty(actual) && a !== e;
    case "contains":
      return !isEmpty(actual) && a.includes(e);
    case "not_contains":
      return !isEmpty(actual) && !a.includes(e);
    case "greater_than": {
      const [x, y] = toNumbers(actual, expected, operator);
      return x > y;
    }
    case "less_than": {
      const [x, y] = toNumbers(actual, expected, operator);
      return x < y;
    }
    case "is_empty":
      return isEmpty(actual);
    case "is_not_empty":
      return !isEmpty(actual);
    default:
      throw new Error(`Unsupported condition operator: ${operator}`);
  }
};

const loadExecution = (executionId) =>
  prisma.journeyExecution.findUnique({
    where: { id: executionId },
    include: { logs: { orderBy: { createdAt: "asc" } } },
  });

/**
 * Runs a journey execution that is already marked "running".
 * mode: "test" (simulated, no waiting) or "live" (worker run).
 * On failure it marks the execution/enrollment failed and re-throws.
 */
export async function processJourneyExecution(executionId, mode) {
  const isTest = mode === "test";

  const log = (level, message, nodeId, metadata = {}) =>
    prisma.executionLog.create({
      data: { executionId, nodeId, level, message, metadata: { mode, ...metadata } },
    });

  try {
    const execution = await prisma.journeyExecution.findFirst({
      where: { id: executionId, isTest, status: "running" },
    });
    if (!execution) throw new Error("Running execution not found.");

    const journey = await prisma.journey.findUnique({
      where: { id: execution.journeyId },
      include: { nodes: true, edges: true },
    });
    if (!journey) throw new Error("Journey not found.");

    const nodes = new Map(journey.nodes.map((n) => [n.id, n]));
    const edgeFrom = (nodeId, handle) =>
      journey.edges.find(
        (e) =>
          e.sourceNodeId === nodeId &&
          (handle === undefined || e.sourceHandle?.toLowerCase() === handle)
      );

    const triggerData = toObject(execution.triggerData);
    const visited = new Set();
    let currentNodeId = execution.currentNodeId;
    let steps = 0;

    await log("info", isTest ? "Test execution started." : "Live execution started.");

    while (currentNodeId) {
      if (++steps > MAX_STEPS) throw new Error("Maximum execution steps exceeded.");
      if (visited.has(currentNodeId)) {
        throw new Error(`Circular connection detected at node ${currentNodeId}.`);
      }
      visited.add(currentNodeId);

      const node = nodes.get(currentNodeId);
      if (!node) throw new Error(`Node not found: ${currentNodeId}`);

      await prisma.journeyExecution.update({
        where: { id: executionId },
        data: { currentNodeId: node.id },
      });

      const config = toObject(node.config);
      let message = "";
      let level = "info";
      let edge;
      let branch;
      let delayUntil = null;
      let extra = {};

      switch (node.type) {
        case "trigger":
          message = `Trigger processed: ${node.title}`;
          edge = edgeFrom(node.id);
          break;

        case "condition": {
          const result = evaluateCondition(config, triggerData);
          branch = result ? "yes" : "no";
          edge = edgeFrom(node.id, branch);
          message = result
            ? `Condition evaluated TRUE. YES branch selected: ${node.title}`
            : `Condition evaluated FALSE. NO branch selected: ${node.title}`;
          if (!edge) {
            level = "warning";
            message += ". No matching branch connection found.";
          }
          extra = {
            conditionField: config.conditionField ?? null,
            operator: config.operator ?? null,
            expectedValue: config.value ?? null,
            actualValue: triggerData[String(config.conditionField ?? "")] ?? null,
            selectedBranch: branch,
          };
          break;
        }

        case "email":
        case "whatsapp":
        case "sms":
          message = isTest
            ? `${node.title} simulated successfully. No real message was sent.`
            : `${node.title} reached. Provider integration is not connected; no real message was sent.`;
          edge = edgeFrom(node.id);
          break;

        case "delay": {
          const duration = Number(config.duration);
          const unit = String(config.unit ?? "minutes");
          if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error("Delay duration must be a positive number.");
          }
          if (!UNIT_MS[unit]) throw new Error(`Unsupported delay unit: ${unit}`);

          edge = edgeFrom(node.id);
          if (!edge) throw new Error("Delay node has no outgoing connection.");

          delayUntil = new Date(Date.now() + duration * UNIT_MS[unit]);
          message = isTest
            ? `Delay simulated: ${duration} ${unit}. No actual waiting applied.`
            : `Delay scheduled for ${duration} ${unit}. Journey will resume at ${delayUntil.toISOString()}.`;
          break;
        }

        case "assign":
          message = "Assign node processed. No actual assignment was performed.";
          edge = edgeFrom(node.id);
          break;

        case "end":
          message = `Journey reached end node: ${node.title}`;
          break;

        default:
          throw new Error(`Unsupported node type: ${node.type}`);
      }

      await log(level, message, node.id, {
        nodeType: node.type,
        nodeTitle: node.title,
        ...extra,
      });

      // Live delay: park the execution; the worker resumes it at nextRunAt.
      if (node.type === "delay" && !isTest) {
        await prisma.journeyExecution.update({
          where: { id: executionId },
          data: {
            status: "queued",
            currentNodeId: edge.targetNodeId,
            nextRunAt: delayUntil,
          },
        });
        return loadExecution(executionId);
      }

      if (node.type === "end") break;
      currentNodeId = edge?.targetNodeId ?? "";
    }

    await prisma.journeyExecution.update({
      where: { id: executionId },
      data: {
        status: "completed",
        currentNodeId: null,
        completedAt: new Date(),
        errorMessage: null,
      },
    });

    if (!isTest) {
      await prisma.journeyEnrollment.updateMany({
        where: { executionId, status: "active" },
        data: { status: "completed", completedAt: new Date() },
      });
    }

    return loadExecution(executionId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown execution error.";

    await prisma.journeyExecution.updateMany({
      where: { id: executionId, isTest, status: "running" },
      data: { status: "failed", errorMessage, completedAt: new Date() },
    });

    if (!isTest) {
      await prisma.journeyEnrollment.updateMany({
        where: { executionId, status: "active" },
        data: { status: "failed", exitedAt: new Date() },
      });
    }

    await log("error", errorMessage, undefined, { error: true }).catch((e) =>
      console.error("Failed to save execution error log:", e)
    );

    throw error;
  }
}