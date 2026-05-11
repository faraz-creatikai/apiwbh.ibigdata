import prisma from "../../config/prismaClient.js";
import { sendNotification } from "../../controllers/notificationController.js";
import { getNotificationReceivers } from "./notificationResolver.js";


//delete old notifications every day at midnight
const NOTIFICATION_RETENTION_DAYS = 30; // ← change this one number only

export const deleteOldNotifications = async () => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - NOTIFICATION_RETENTION_DAYS);

  const result = await prisma.notification.deleteMany({
    where: {
      createdAt: { lt: cutoffDate },
      isRead: true,
    },
  });

  console.log(`🗑️ Deleted ${result.count} old notifications (older than ${NOTIFICATION_RETENTION_DAYS} days)`);
};

export const notifyCustomerCreated = async ({ customer, admin }) => {
  const receiverIds = await getNotificationReceivers(admin);

  // avoid sending notification to self
  const filteredReceivers = receiverIds.filter(id => id !== admin.id);

  await sendNotification({
    type: "CUSTOMER_CREATED",
    title: "New Customer Created",
    message: `${customer.customerName} has been added`,
    entityId: customer.id,
    entityType: "Customer",
    receiverIds: filteredReceivers,
    senderId: admin.id,
    metadata: {
      phone: customer.ContactNumber,
    },
  });
};


export const notifyCustomerFollowupTaken = async ({ customer, admin }) => {
  const receiverIds = await getNotificationReceivers(admin);

  // avoid sending notification to self
  const filteredReceivers = receiverIds.filter(id => id !== admin.id);

  await sendNotification({
    type: "CUSTOMER_FOLLOWUP_TAKEN",
    title: "Customer Follow-up Taken",
    message: `${customer.customerName} has been followed up`,
    entityId: customer.id,
    entityType: "Customer",
    receiverIds: filteredReceivers,
    senderId: admin.id,
    metadata: {
      phone: customer.ContactNumber,
    },
  });
};

export const notifyNewUserRequest = async ({ newUser }) => {
  const admins = await prisma.admin.findMany({
    where: { role: "administrator" },
    select: { id: true },
  });

  const receiverIds = admins.map(a => a.id);


  console.log("Receivers for new user request notification:", receiverIds);

  await sendNotification({
    type: "NEW_USER_REQUEST",
    title: "New User Request",
    message: `${newUser.name} has requested to create an account`,
    entityId: newUser.id,
    entityType: "User",
    receiverIds: receiverIds,
    senderId: null,
    metadata: {
      phone: newUser.phone,
    },
  });
};


//followup notify

// ─── Notify Followup Due (called manually if needed) ──────────────────────────
export const notifyFollowupNext = async ({ followup, customer }) => {
  // get all administrators
  const administrators = await prisma.admin.findMany({
    where: { role: "administrator" },
    select: { id: true },
  });
 // console.log("Administrators to notify for followup:", administrators);
  const adminIds = administrators.map(a => a.id);

  // get the one who created the followup
  const creatorId = followup.CreatedById;

  // merge both, remove duplicates
  const receiverIds = [...new Set([
    ...adminIds,
    ...(creatorId ? [creatorId] : []),
  ])];

  await sendNotification({
    type: "FOLLOWUP_DUE",
    title: "Follow Up Due",
    message: `Don’t miss the follow-up with ${customer.customerName}`,
    entityId: customer.id,
    entityType: "Customer",
    receiverIds,
    senderId: null, // system triggered, no sender
    metadata: {
      phone: customer.ContactNumber,
      followupDate: followup.FollowupNextDate,
    },
  });
};


// ─── Cron: runs every 24 hours, checks all due followups ─────────────────────
export const initFollowupNotificationCron = () => {
  setInterval(async () => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      console.log(` Checking due/overdue followups...`);

      // get ALL unnotified followups
      const allUnnotified = await prisma.followup.findMany({
        where: {
          isNotified: false,
          FollowupNextDate: { not: null },
        },
        include: { customer: true },
      });

      // filter: today OR any past unnotified date
      const dueFollowups = allUnnotified.filter((followup) => {
        if (!followup.FollowupNextDate) return false;

        // parse "dd-mm-yyyy" into a Date
        const [dd, mm, yyyy] = followup.FollowupNextDate.split("-");
        const followupDate = new Date(`${yyyy}-${mm}-${dd}`);
        followupDate.setHours(0, 0, 0, 0);

        return followupDate <= today; // today OR overdue ✅
      });

      console.log(` Found ${dueFollowups.length} due/overdue followups`);

      for (const followup of dueFollowups) {
        await notifyFollowupNext({ followup, customer: followup.customer });

        // mark as notified so it never fires again
        await prisma.followup.update({
          where: { id: followup.id },
          data: { isNotified: true },
        });
      }

    } catch (err) {
      console.error(" Followup notification cron error:", err);
    }
  }, 24 * 60 * 60 * 1000); // every 24 hours
};