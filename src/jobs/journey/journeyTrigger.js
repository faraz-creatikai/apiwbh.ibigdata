import prisma from "../../config/prismaClient.js";

// Data the journey engine receives when a customer enters a journey.
// (Moved here from controller.journey.js so it can be shared without a circular import.)
export const buildTriggerData = (customer, enrollmentId) => {
  const [firstName = "", ...rest] = (customer.customerName || "")
    .trim()
    .split(/\s+/);

  return {
    customerId: customer.id,
    customerName: customer.customerName,
    name: customer.customerName,
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

const DEFAULT_EVENT = "new_lead_added"; // the builder shows this when nothing was picked

/**
 * Starts every ACTIVE journey of `ownerId` whose trigger node listens for `event`
 * (trigger config.triggerEvent) for this customer. The run is only queued here;
 * the worker executes it.
 *
 * Never throws, so the action that fired it (e.g. creating a customer) can't fail
 * because of a journey problem.
 *
 * To add another trigger later: call fireJourneyEvent("form_submitted", customer, adminId)
 * from the place where that happens. The event name must match the builder's option value.
 */
export async function fireJourneyEvent(event, customer, ownerId) {
  try {
    const journeys = await prisma.journey.findMany({
      where: {
        status: "active",
        createdById: ownerId,
        nodes: { some: { type: "trigger" } },
      },
      select: {
        id: true,
        nodes: {
          where: { type: "trigger" },
          select: { id: true, config: true },
          take: 1,
        },
      },
    });

    for (const journey of journeys) {
      const trigger = journey.nodes[0];
      const config =
        trigger?.config && typeof trigger.config === "object" ? trigger.config : {};

      if (!trigger || (config.triggerEvent ?? DEFAULT_EVENT) !== event) continue;

      try {
        await prisma.$transaction(async (tx) => {
          const enrollment = await tx.journeyEnrollment.create({
            data: {
              journeyId: journey.id,
              customerId: customer.id,
              source: event,
              status: "active",
            },
          });

          const execution = await tx.journeyExecution.create({
            data: {
              journeyId: journey.id,
              customerId: customer.id,
              status: "queued",
              isTest: false,
              currentNodeId: trigger.id,
              triggerData: buildTriggerData(customer, enrollment.id),
              logs: {
                create: {
                  nodeId: trigger.id,
                  level: "info",
                  message: `Triggered by "${event}". Journey execution queued.`,
                  metadata: { enrollmentId: enrollment.id, source: event },
                },
              },
            },
          });

          await tx.journeyEnrollment.update({
            where: { id: enrollment.id },
            data: { executionId: execution.id },
          });
        });
      } catch (err) {
        // P2002 = this customer is already enrolled in this journey: nothing to do.
        if (err.code !== "P2002") {
          console.error(`Journey ${journey.id} could not start for customer ${customer.id}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("fireJourneyEvent failed:", err.message);
  }
}