import { PrismaClient } from "@prisma/client";
import { sendEmail } from "../config/mailer.js";
import { sendWhatsApp } from "../config/twilio.js";
import ApiError from "../utils/ApiError.js";

const prisma = new PrismaClient();

// --------------------------------------------
// 🔀 PLACEHOLDER REPLACEMENT (Same Logic)
// --------------------------------------------
const replacePlaceholders = (templateText, customer) => {
  if (!templateText) return templateText;

  const map = {
    name: customer.customerName || customer.name || "",
    email: customer.Email || "",
    contact: customer.ContactNumber || customer.Contact || "",
    city: customer.City || customer.city || "",
    propertyType: customer.CustomerSubType || customer.propertyType || "",
  };

  Object.keys(customer).forEach((k) => {
    const val = customer[k];
    if (val === undefined || val === null) return;
    map[k.toLowerCase()] = typeof val === "string" ? val : String(val);
  });

  return templateText.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
    return map[key.trim().toLowerCase()] ?? "";
  });
};

// --------------------------------------------
// 📌 Fetch Customers
// --------------------------------------------
const fetchTargetCustomers = async ({
  customerIds = [],
  sendToAll = false,
}) => {
  if (sendToAll) {
    return prisma.customer.findMany();
  }
  if (!Array.isArray(customerIds) || customerIds.length === 0) return [];

  return prisma.customer.findMany({
    where: {
      id: { in: customerIds },
    },
  });
};

// ===================================================================
// 📧 SEND EMAIL BY TEMPLATE
// ===================================================================
export const sendEmailByTemplate = async (req, res, next) => {
  try {
    const { templateId, customerIds = [], sendToAll = false } = req.body;
    if (!templateId) return next(new ApiError(400, "templateId is required"));

    const template = await prisma.template.findUnique({
      where: { id: templateId },
    });
    if (!template) return next(new ApiError(404, "Template not found"));
    if (template.type !== "email")
      return next(new ApiError(400, "Template type must be 'email'"));

    const customers = await fetchTargetCustomers({ customerIds, sendToAll });
    if (!customers.length) return next(new ApiError(404, "No customers found"));

    const results = [];

    for (const c of customers) {
      try {
        if (!c.Email) {
          results.push({
            id: c.id,
            name: c.customerName,
            status: "skipped_no_email",
          });
          continue;
        }

        const subject = replacePlaceholders(template.subject, c);
        const html = replacePlaceholders(template.body, c);

        const info = await sendEmail(c.Email, subject, html);

        results.push({
          id: c.id,
          email: c.Email,
          status: "sent",
          info: info.messageId || info.response,
        });
      } catch (err) {
        results.push({
          id: c.id,
          name: c.customerName,
          status: "failed",
          error: err.message,
        });
      }
    }

    res.status(200).json({
      success: true,
      sent: results.filter((r) => r.status === "sent").length,
      results,
    });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};

// ===================================================================
// 💬 SEND WHATSAPP BY TEMPLATE
// ===================================================================
export const sendWhatsAppByTemplate = async (req, res, next) => {
  try {
    const { templateId, customerIds = [], sendToAll = false } = req.body;
    if (!templateId) return next(new ApiError(400, "templateId is required"));

    const template = await prisma.template.findUnique({
      where: { id: templateId },
    });
    if (!template) return next(new ApiError(404, "Template not found"));
    if (template.type !== "whatsapp")
      return next(new ApiError(400, "Template type must be 'whatsapp'"));

    const customers = await fetchTargetCustomers({ customerIds, sendToAll });
    if (!customers.length) return next(new ApiError(404, "No customers found"));

    const results = [];

    for (const c of customers) {
      try {
        const phone = c.ContactNumber || "";
        if (!phone) {
          results.push({
            id: c.id,
            name: c.customerName,
            status: "skipped_no_phone",
          });
          continue;
        }

        const formattedPhone = phone.startsWith("+")
          ? phone
          : `${process.env.DEFAULT_COUNTRY_CODE || "+91"}${phone}`;

        const message = replacePlaceholders(template.body, c);

        const result = await sendWhatsApp(formattedPhone, message);

        results.push({
          id: c.id,
          phone: formattedPhone,
          status: "sent",
          sid: result.sid,
        });
      } catch (err) {
        results.push({
          id: c.id,
          name: c.customerName,
          status: "failed",
          error: err.message,
        });
      }
    }

    res.status(200).json({
      success: true,
      sent: results.filter((r) => r.status === "sent").length,
      results,
    });
  } catch (err) {
    next(new ApiError(500, err.message));
  }
};
