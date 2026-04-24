import { PrismaClient } from "@prisma/client";
import { sendEmail } from "../config/mailer.js";
import { sendWhatsApp } from "../config/twilio.js";
import ApiError from "../utils/ApiError.js";
import { makeCall } from "../config/exotel.js";

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


        const imageUrl = template.whatsappImage?.[0] || null;

        const result = await sendWhatsApp(
          formattedPhone,
          message,
          imageUrl
        );

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


export const callCustomer = async (req,res,next) =>{
  try{
    const { customerNumber }=req.body;

    if(!customerNumber){
      res.status(400).json({
        success:false,
        message:"please provide customer number"
      })
      return;
    }
    const response = await makeCall(customerNumber);

    console.log(" making call to customer ", response);
    res.status(200).json({
      success:true,
      call: response
    })
  }
  catch(err){
     next(new ApiError(500, err.message));
  }
}

export const sendWhatsAppMessage = async (req, res, next) => {
  try {
    const { templateId, customerIds = [] } = req.body;

    if (!templateId) {
      return next(new ApiError(400, "templateId is required"));
    }

    if (!customerIds.length) {
      return next(new ApiError(400, "customerIds are required"));
    }

    // 1. Get template
    const template = await prisma.template.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      return next(new ApiError(404, "Template not found"));
    }

    if (template.type !== "whatsapp") {
      return next(new ApiError(400, "Template type must be 'whatsapp'"));
    }

    // 2. Get customers
    const customers = await prisma.customer.findMany({
      where: {
        id: { in: customerIds },
      },
    });

    if (!customers.length) {
      return next(new ApiError(404, "No customers found"));
    }

    const results = [];

    // 3. Loop customers (with delay to avoid rate limit)
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
          : `${process.env.DEFAULT_COUNTRY_CODE || "91"}${phone}`;

        // Replace placeholders
        const message = replacePlaceholders(template.body, c);

        // Get first image (if exists)
        const imageUrl = template.whatsappImage?.[0] || null;

        // Build payload
        let payload;

        if (imageUrl) {
          payload = {
            messaging_product: "whatsapp",
            to: formattedPhone,
            type: "image",
            image: {
              link: imageUrl,
              caption: message,
            },
          };
        } else {
          payload = {
            messaging_product: "whatsapp",
            to: formattedPhone,
            type: "text",
            text: {
              body: message,
            },
          };
        }

        const url = `https://graph.facebook.com/v25.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;

        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          results.push({
            id: c.id,
            phone: formattedPhone,
            status: "failed",
            error: data,
          });
          continue;
        }

        results.push({
          id: c.id,
          phone: formattedPhone,
          status: "sent",
          messageId: data?.messages?.[0]?.id || null,
        });

      } catch (err) {
        results.push({
          id: c.id,
          name: c.customerName,
          status: "failed",
          error: err.message,
        });
      }

      // ⛔ small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 300));
    }

    res.status(200).json({
      success: true,
      sent: results.filter((r) => r.status === "sent").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });

  } catch (err) {
    next(new ApiError(500, err.message));
  }
};


