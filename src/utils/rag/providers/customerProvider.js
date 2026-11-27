import prisma from "../../../config/prismaClient.js";
import { getCustomerAccessFilter } from "../../../controllers/controller.customer.js";


/**
 * Fetches structured Customer records from MySQL respecting admin role permissions.
 */
export async function fetchCustomerContext({
  admin,
  customerId,
  filters = {},
  limit = 15,
}) {
  const accessFilter = admin ? await getCustomerAccessFilter(admin) : {};
  const adminId = admin?.id || admin?._id;

  const AND = [
    ...(Object.keys(accessFilter).length > 0 ? [accessFilter] : []),
    ...(adminId ? [{ archivedBy: { none: { adminId } } }] : []),
  ];

  // If user selected a specific customer in the chat UI, fetch that exact customer
  if (customerId) {
    AND.push({ id: customerId });
  } else {
    if (filters.keyword) {
      const kw = String(filters.keyword).trim();
      AND.push({
        OR: [
          { customerName: { contains: kw } },
          { ContactNumber: { contains: kw } },
          { Email: { contains: kw } },
          { City: { contains: kw } },
          { Location: { contains: kw } },
          { SubLocation: { contains: kw } },
          { Campaign: { contains: kw } },
          { CustomerType: { contains: kw } },
          { Description: { contains: kw } },
          { Other: { contains: kw } },
        ],
      });
    }

    if (filters.city) {
      AND.push({ City: { contains: String(filters.city).trim() } });
    }
    if (filters.location) {
      AND.push({
        OR: [
          { Location: { contains: String(filters.location).trim() } },
          { SubLocation: { contains: String(filters.location).trim() } },
        ],
      });
    }
    if (filters.campaign) {
      AND.push({ Campaign: { contains: String(filters.campaign).trim() } });
    }
    if (filters.leadTemperature) {
      AND.push({ LeadTemperature: { contains: String(filters.leadTemperature).trim() } });
    }
    if (filters.customerType) {
      AND.push({ CustomerType: { contains: String(filters.customerType).trim() } });
    }
    if (typeof filters.dealClosed === "boolean") {
      AND.push({ DealClosed: filters.dealClosed });
    }
    if (typeof filters.isFavourite === "boolean") {
      AND.push({ isFavourite: filters.isFavourite });
    }
    if (filters.minPrice !== null && filters.minPrice !== undefined) {
      AND.push({ PriceNumber: { gte: Number(filters.minPrice) } });
    }
    if (filters.maxPrice !== null && filters.maxPrice !== undefined) {
      AND.push({ PriceNumber: { lte: Number(filters.maxPrice) } });
    }
  }

  const where = AND.length > 0 ? { AND } : {};

  const [totalMatching, rows] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: customerId ? 1 : Math.min(limit, 25),
      select: {
        id: true,
        customerName: true,
        ContactNumber: true,
        CountryCode: true,
        Email: true,
        City: true,
        Location: true,
        SubLocation: true,
        Area: true,
        Adderess: true,
        Campaign: true,
        CustomerType: true,
        CustomerSubType: true,
        LeadType: true,
        LeadTemperature: true,
        Price: true,
        PriceNumber: true,
        Facillities: true,
        Verified: true,
        DealClosed: true,
        isFavourite: true,
        CustomerDate: true,
        Description: true,
        Other: true,
        CustomerFields: true,
        AssignTo: { select: { name: true, role: true } },
        _count: {
          select: {
            followups: true,
            callLogs: true,
            documents: true,
          },
        },
      },
    }),
  ]);

  // Respect agent phone masking rule
  const customers = rows.map((c) => ({
    ...c,
    ContactNumber:
      admin?.role === "agent" && c.CreatedById !== adminId
        ? "Masked"
        : c.ContactNumber,
  }));

  return { totalMatching, customers };
}