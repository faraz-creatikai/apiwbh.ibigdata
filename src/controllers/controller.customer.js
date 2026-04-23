import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import fs from "fs";
import cloudinary from "../config/cloudinary.js";
import { getKeywordSearchData, getRecommendedKeywordSearchData } from "../ai/getKeywordSearchData.js";

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { CallingAgent, DataMiningAgent, QualifyAgent } from "../ai/agent.js";
import { callingAgentPrompt } from "../ai/prompts/callingAgentPrompt.js";

dayjs.extend(utc);
dayjs.extend(timezone);

// ======================================================
//                   HELPERS
// ======================================================

const parseJSON = (field) => {
  if (!field) return [];
  if (typeof field === "string") {
    try {
      return JSON.parse(field);
    } catch {
      return [];
    }
  }
  return field;
};

const safeParse = (val) => {
  if (val === undefined || val === null || val === "") return undefined;
  if (Array.isArray(val)) return val;

  try {
    return JSON.parse(val);
  } catch {
    return undefined;
  }
};

const getPublicIdFromUrl = (url) => {
  try {
    const parts = url.split("/");
    const file = parts.pop();
    return file.split(".")[0];
  } catch {
    return null;
  }
};

// ------------------------------------------------------
//      Attach AssignTo information (only basic)
// ------------------------------------------------------
const transformGetCustomer = async (c) => {
  const base = {
    ...c,
    _id: c.id,
    CustomerDate: c.CustomerDate,
    CustomerImage: parseJSON(c.CustomerImage),
    SitePlan: parseJSON(c.SitePlan),
  };

  // FIX: Prisma column is AssignToId, not AssignTo
  const assignToDoc = c.AssignToId
    ? await prisma.admin.findUnique({
      where: { id: c.AssignToId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        city: true,
      },
    })
    : null;

  return {
    ...base,
    /* AssignTo: assignToDoc
      ? {
        _id: assignToDoc.id,
        name: assignToDoc.name,
        email: assignToDoc.email,
        role: assignToDoc.role,
        city: assignToDoc.city,
      }
      : null, */
  };
};

// ------------------------------------------------------
//      Transform single customer (getCustomerById)
// ------------------------------------------------------
const transformCustomer = async (c) => {
  const base = {
    ...c,
    _id: c.id,
    CustomerImage: parseJSON(c.CustomerImage),
    SitePlan: parseJSON(c.SitePlan),
  };

  const [
    campaignDoc,
    typeDoc,
    subTypeDoc,
    cityDoc,
    locationDoc,
    subLocationDoc,
    assignToDoc,
    createdByDoc,
  ] = await Promise.all([
    prisma.campaign.findFirst({
      where: { Name: c.Campaign },
      select: { id: true, Name: true },
    }),
    prisma.type.findFirst({
      where: { Name: c.CustomerType },
      select: { id: true, Name: true },
    }),
    prisma.subType.findFirst({
      where: { Name: c.CustomerSubType },
      select: { id: true, Name: true },
    }),
    prisma.city.findFirst({
      where: { Name: c.City },
      select: { id: true, Name: true },
    }),
    prisma.location.findFirst({
      where: { Name: c.Location },
      select: { id: true, Name: true },
    }),
    prisma.subLocation.findFirst({
      where: { Name: c.SubLocation },
      select: { id: true, Name: true },
    }),
    c.AssignToId
      ? prisma.admin.findUnique({
        where: { id: c.AssignToId },
        select: { id: true, name: true, email: true, role: true, city: true },
      })
      : null,
    c.CreatedBy
      ? prisma.admin.findUnique({
        where: { id: c.CreatedBy },
        select: { id: true, name: true, email: true },
      })
      : null,
  ]);

  return {
    ...base,
    Campaign: campaignDoc
      ? { _id: campaignDoc.id, Name: campaignDoc.Name }
      : { _id: null, Name: c.Campaign || "" },

    CustomerType: typeDoc
      ? { _id: typeDoc.id, Name: typeDoc.Name }
      : { _id: null, Name: c.CustomerType || "" },

    CustomerSubType: subTypeDoc
      ? { _id: subTypeDoc.id, Name: subTypeDoc.Name }
      : { _id: null, Name: c.CustomerSubType || "" },

    City: cityDoc
      ? { _id: cityDoc.id, Name: cityDoc.Name }
      : { _id: null, Name: c.City || "" },

    Location: locationDoc
      ? { _id: locationDoc.id, Name: locationDoc.Name }
      : { _id: null, Name: c.Location || "" },
    SubLocation: subLocationDoc
      ? { _id: subLocationDoc.id, Name: subLocationDoc.Name }
      : { _id: null, Name: c.SubLocation || "" },

    AssignTo: assignToDoc
      ? {
        _id: assignToDoc.id,
        name: assignToDoc.name,
        email: assignToDoc.email,
        role: assignToDoc.role,
        city: assignToDoc.city,
      }
      : null,

    CreatedBy: createdByDoc
      ? {
        _id: createdByDoc.id,
        name: createdByDoc.name,
        email: createdByDoc.email,
      }
      : null,
  };
};

const toBoolean = (val) => {
  if (val === undefined || val === null) return undefined;

  if (typeof val === "boolean") return val;

  if (typeof val === "string") {
    const lower = val.toLowerCase().trim();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }

  return undefined; // if invalid or empty string
};


// --------------------------------------------
// REMOVE DUPLICATES BY CONTACTNUMBER, KEEP LAST UPDATED
// --------------------------------------------
function deduplicateByContact(customers) {
  const map = new Map();

  customers.forEach((c) => {
    if (!c.ContactNumber) return; // skip empty
    const existing = map.get(c.ContactNumber);

    if (!existing) {
      map.set(c.ContactNumber, c);
    } else {
      // compare updatedAt (fallback to createdAt)
      const existingDate = existing.updatedAt || existing.createdAt;
      const currentDate = c.updatedAt || c.createdAt;

      if (currentDate > existingDate) {
        map.set(c.ContactNumber, c);
      }
    }
  });

  return Array.from(map.values());
}

// ======================================================
//                   CONTROLLERS
// ======================================================


// ------------------------------------------------------
//               GET TODAY CUSTOMERS
// ------------------------------------------------------
export const getTodayCustomers = async (req, res, next) => {
  try {
    const admin = req.admin;

    let AND = [];

    // 🕒 TODAY RANGE
    const start = dayjs()
      .tz("Asia/Kolkata")
      .startOf("day")
      .utc()
      .toDate();

    const end = dayjs()
      .tz("Asia/Kolkata")
      .endOf("day")
      .utc()
      .toDate();

    // --------------------------------------------
    // ROLE-BASED FILTERS (SAME AS YOUR API)
    // --------------------------------------------

    if (admin.role !== "administrator" && admin.clientId) {
      AND.push({
        OR: [
          { ClientId: admin.clientId },
          { CreatedById: admin.id || admin._id }
        ]
      });
    }

    if (admin.role === "user") {
      const adminId = admin.id || admin._id;

      AND.push({
        OR: [
          {
            AssignTo: {
              some: { id: adminId }
            }
          },
          {
            CreatedById: adminId
          }
        ]
      });
    }

    else if (admin.role === "city_admin") {
      const adminId = admin.id || admin._id;

      // 🔹 get assigned campaigns
      const assignedCampaignsData = await prisma.customer.findMany({
        where: {
          AssignTo: {
            some: { id: adminId }
          }
        },
        select: { Campaign: true },
        distinct: ["Campaign"]
      });

      const assignedCampaigns = assignedCampaignsData
        .map(c => c.Campaign)
        .filter(Boolean);

      AND.push({
        OR: [
          {
            CreatedById: adminId
          },
          {
            AND: [
              {
                AssignTo: {
                  some: { id: adminId }
                }
              },
              {
                City: {
                  contains: admin.city
                }
              }
            ]
          },
          ...(assignedCampaigns.length > 0
            ? [{
              AND: [
                {
                  Campaign: { in: assignedCampaigns }
                },
                {
                  City: {
                    contains: admin.city
                  }
                }
              ]
            }]
            : [])
        ]
      });
    }

    // --------------------------------------------
    // TODAY FILTER
    // --------------------------------------------
    AND.push({
      createdAt: {
        gte: start,
        lte: end
      }
    });

    const customers = await prisma.customer.findMany({
      where: { AND },
      orderBy: {
        createdAt: "desc"
      },
      include: {
        AssignTo: true
      }
    });
    const transformedCustomers = await Promise.all(
      customers.map(c => transformGetCustomer(c))
    );

    res.status(200).json(transformedCustomers);


  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------
//               GET CUSTOMERS
// ------------------------------------------------------
export const getCustomer = async (req, res, next) => {
  try {
    const admin = req.admin;

    const {
      Campaign,
      CustomerType,
      CustomerSubType,
      LeadTemperature,
      StatusType,
      City,
      Location,
      SubLocation,
      LeadType,
      Keyword,
      SearchIn,
      ReferenceId,
      MinPrice,
      MaxPrice,
      Price,
      isFavourite,
      StartDate,
      EndDate,
      Limit,
      Skip = 0,
      sort,
      User,
      ContactNumber
    } = req.query;

    let AND = [];
    const REQUIRED = Limit !== undefined ? Number(Limit) : 100;
    const FETCH_MULTIPLIER = 3; // safe over-fetch

    const offset = Number(Skip);

    // --------------------------------------------
    // ROLE-BASED FILTERS
    // --------------------------------------------



    if (admin.role !== "administrator" && admin.clientId) {
      AND.push({
        OR: [
          { ClientId: admin.clientId },
          { CreatedById: admin.id || admin._id }
        ]
      });
    }


    // --------------------------------------------
    // USER → ONLY DIRECT ASSIGNMENT (STRICT)
    // --------------------------------------------
    if (admin.role === "user") {
      const adminId = admin.id || admin._id;

      AND.push({
        OR: [
          {
            AssignTo: {
              some: { id: adminId }
            }
          },
          {
            CreatedById: adminId
          }
        ]
      });
    }
    else if (admin.role === "city_admin") {
      const adminId = admin.id || admin._id;

      // Step 1: get campaigns
      const assignedCampaignsData = await prisma.customer.findMany({
        where: {
          AssignTo: {
            some: { id: adminId }
          }
        },
        select: { Campaign: true },
        distinct: ["Campaign"]
      });

      const assignedCampaigns = assignedCampaignsData
        .map(c => c.Campaign)
        .filter(Boolean);

      // STEP 2: GLOBAL CITY FILTER (VERY IMPORTANT)
      AND.push({
        City: {
          equals: admin.city
        }
      });

      // STEP 3: ACCESS LOGIC (non-restrictive now)
      AND.push({
        OR: [
          { CreatedById: adminId },

          {
            AssignTo: {
              some: { id: adminId }
            }
          },

          ...(assignedCampaigns.length > 0
            ? [{
              Campaign: { in: assignedCampaigns }
            }]
            : []),

          // THIS LINE FIXES YOUR CORE ISSUE
          // allow other city data even if not assigned/campaign
          {}
        ]
      });
    }

    // --------------------------------------------
    // BASIC FILTERS
    // --------------------------------------------
    if (Campaign) AND.push({ Campaign: { contains: Campaign.trim() } });

    if (CustomerType)
      AND.push({ CustomerType: { contains: CustomerType.trim() } });

    if (CustomerSubType) AND.push({ CustomerSubType: { contains: CustomerSubType.trim() } });

    if (StatusType) AND.push({ Verified: { contains: StatusType.trim() } });

    if (LeadTemperature) AND.push({ LeadTemperature: { contains: LeadTemperature.trim() } });
    if (LeadType) AND.push({ LeadType: { contains: LeadType.trim() } });

    if (City) AND.push({ City: { contains: City.trim() } });

    if (Location) AND.push({ Location: { contains: Location.trim() } });
    if (SubLocation) AND.push({ SubLocation: { contains: SubLocation.trim() } });
    if (ContactNumber) AND.push({ ContactNumber: { contains: ContactNumber.trim() } });
    if (ReferenceId) AND.push({ ReferenceId: { contains: ReferenceId.trim() } });
    if (Price) AND.push({ Price: { contains: Price.trim() } });
    // --------------------------------------------
    // PRICE RANGE FILTER (MIN / MAX)
    // --------------------------------------------
    const cleanNumber = (val) =>
      Number(String(val || "").replace(/[^0-9]/g, ""));

    if (MinPrice || MaxPrice) {
      const min = MinPrice ? cleanNumber(MinPrice) : null;
      const max = MaxPrice ? cleanNumber(MaxPrice) : null;

      AND.push({
        PriceNumber: {
          ...(min !== null && !isNaN(min) && { gte: min }),
          ...(max !== null && !isNaN(max) && { lte: max }),
        }
      });
    }
    if (typeof isFavourite !== "undefined") {
      AND.push({
        isFavourite: isFavourite === "true"
      });
    }

    // --------------------------------------------
    // KEYWORD SEARCH
    // --------------------------------------------
    const keyword = Keyword?.trim();

    if (keyword) {
      const { tokens, fields, priceRange } = await getKeywordSearchData(keyword);

      console.log(" tokens are ", tokens, "  \n fields are : ", fields)

      // ✅ APPLY KEYWORD FILTER ONLY IF TOKENS EXIST
      if (tokens.length > 0) {
        AND.push({
          AND: tokens.map((t) => ({
            OR: fields.map((field) => ({
              [field]: { contains: t },
            })),
          })),
        });
      }

      // ✅ APPLY PRICE RANGE FROM AI (independent)
      if (priceRange?.min || priceRange?.max) {
        const min = priceRange?.min !== null
          ? Number(String(priceRange.min).replace(/[^0-9]/g, ""))
          : null;

        const max = priceRange?.max !== null
          ? Number(String(priceRange.max).replace(/[^0-9]/g, ""))
          : null;

        if (!isNaN(min) || !isNaN(max)) {
          AND.push({
            PriceNumber: {
              ...(min !== null && !isNaN(min) && { gte: min }),
              ...(max !== null && !isNaN(max) && { lte: max }),
            }
          });
        }
      }
    }

    /*      if (keyword) {
       const tokens = keyword.split(" ").filter(Boolean);
 
       // Default fields (if user does NOT select anything)
       const defaultFields = [
         "Description",
         "Campaign",
         "CustomerType",
         "CustomerSubType",
         "customerName",
         "ContactNumber",
         "City",
         "Location",
         "SubLocation",
         "Price",
         "ReferenceId",
       ];
 
       // User-selected fields (comma-separated)
       // User-selected fields (array or single string)
       let selectedFields;
       if (!SearchIn) {
         selectedFields = defaultFields; // default fields if nothing selected
       } else if (Array.isArray(SearchIn)) {
         selectedFields = SearchIn.map(f => f.trim());
       } else {
         selectedFields = SearchIn.split(",").map(f => f.trim());
       }
 
       AND.push({
         AND: tokens.map((t) => ({
           OR: selectedFields.map((field) => ({
             [field]: { contains: t },
           })),
         })),
       });
     } */




    const where = AND.length ? { AND } : {};

    let orderBy = [];

    if (sort?.toLowerCase() === "asc") {
      orderBy.push({ createdAt: "asc" });
    }
    else {
      orderBy.push({ updatedAt: "desc" });
      orderBy.push({ createdAt: "desc" });
    }

    // --------------------------------------------
    // TOTAL COUNT (FOR PAGINATION)
    // --------------------------------------------
    //console.log("FINAL WHERE => ", JSON.stringify(where, null, 2));
    const totalRecords = await prisma.customer.count({ where });

    // --------------------------------------------
    // MAIN PRISMA FETCH
    // --------------------------------------------

    let customers;

    if (Limit !== undefined) {
      const REQUIRED = Number(Limit);

      if (!ContactNumber) {
        const BUFFER = REQUIRED * FETCH_MULTIPLIER;

        customers = await prisma.customer.findMany({
          where,
          orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" }
          ],
          distinct: ["ContactNumber"],
          skip: 0,
          take: BUFFER, // ✅ changed
          include: { AssignTo: true }
        });

        // ✅ global sorting
        customers.sort((a, b) => {
          const aTime = new Date(a.updatedAt || a.createdAt).getTime();
          const bTime = new Date(b.updatedAt || b.createdAt).getTime();
          return bTime - aTime;
        });

        // ✅ FINAL LIMIT APPLY HERE ONLY
        customers = customers.slice(0, REQUIRED);
      } else {
        customers = await prisma.customer.findMany({
          where,
          orderBy,
          skip: Limit !== undefined ? offset : undefined,
          take: REQUIRED,
          include: { AssignTo: true }
        });
      }

    } else {
      if (!ContactNumber) {
        // ✅ 🔥 APPLY DISTINCT HERE ALSO
        customers = await prisma.customer.findMany({
          where,
          orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" }
          ],
          distinct: ["ContactNumber"],
          skip: offset,
          include: { AssignTo: true }
        });

        // ✅ IMPORTANT: re-sort globally
        customers.sort((a, b) => {
          const aTime = new Date(a.updatedAt || a.createdAt).getTime();
          const bTime = new Date(b.updatedAt || b.createdAt).getTime();
          return bTime - aTime;
        });

      } else {
        // ✅ normal flow
        customers = await prisma.customer.findMany({
          where,
          orderBy,
          skip: offset,
          include: { AssignTo: true }
        });
      }
    }


    // --------------------------------------------
    // POST-FETCH FILTER + SORT BY CustomerDate
    // ONLY IF BOTH START AND END PROVIDED
    // --------------------------------------------
    if (StartDate && EndDate) {

      const parseDMY = (str) => {
        if (!str) return null;

        const parts = str.split("-");
        if (parts.length !== 3) return null;

        let day, month, year;

        // yyyy-mm-dd
        if (parts[0].length === 4) {
          [year, month, day] = parts.map(Number);
        }
        // dd-mm-yyyy
        else {
          [day, month, year] = parts.map(Number);
        }

        const d = new Date(year, month - 1, day);
        d.setHours(0, 0, 0, 0); // 🔥 normalize time

        return isNaN(d.getTime()) ? null : d;
      };

      const start = parseDMY(StartDate);
      const end = parseDMY(EndDate);

      if (start && end) {

        end.setHours(23, 59, 59, 999); // include full end day

        // 1️⃣ FILTER FIRST
        customers = customers.filter((c) => {
          const d = parseDMY(c.CustomerDate);
          return d && d >= start && d <= end;
        });

        // 2️⃣ DEDUPLICATE BEFORE SORT (important)
        /*  if (!ContactNumber) {
           customers = deduplicateByContact(customers);
         } */

        // 3️⃣ STRICT ASC SORT (24 → 25 → 26 → 27 → 28)
        customers.sort((a, b) => {
          const aTime = parseDMY(a.CustomerDate)?.getTime() || 0;
          const bTime = parseDMY(b.CustomerDate)?.getTime() || 0;
          return bTime - aTime;
        });
      }
    }





    // --------------------------------------------
    // FILTER BY USER (name / email / role / city)
    // --------------------------------------------
    if (User) {
      const userLower = User.toLowerCase();

      const admins = await prisma.admin.findMany({
        where: {
          OR: [
            { name: { contains: User } },
            { email: { contains: User } },
            { city: { contains: User } },

            // ENUM ROLE MATCH (no contains allowed)
            ["admin", "city_admin", "user"].includes(userLower)
              ? { role: { equals: User } }
              : undefined,
          ].filter(Boolean),
        },
        select: { id: true },
      });

      const allowedIds = admins.map((a) => a.id);

      const filtered = customers.filter(
        (c) => c.AssignTo?.some(a => allowedIds.includes(a.id))
      );
      customers.sort((a, b) => {
        const aTime = new Date(a.updatedAt || a.createdAt).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt).getTime();
        return bTime - aTime;
      });
      const transformed = await Promise.all(filtered.map(transformGetCustomer));

      return res.status(200).json(transformed);
    }

    // --------------------------------------------
    // PRIORITY-BASED MATCHING & RANKING (AI-LIKE)
    // --------------------------------------------
    /* if (keyword) {
      const tokens = keyword.split(" ").filter(Boolean);

      customers = customers.map((c) => {
        let score = 0;

        const desc = c.Description?.toLowerCase() || "";
        const campaign = c.Campaign?.toLowerCase() || "";
        const type = c.CustomerType?.toLowerCase() || "";
        const subtype = c.CustomerSubType?.toLowerCase() || "";
        const city = c.City?.toLowerCase() || "";
        const location = c.Location?.toLowerCase() || "";
        const sublocation = c.SubLocation?.toLowerCase() || "";
        const price = c.Price?.toString() || "";
        const ref = c.ReferenceId?.toLowerCase() || "";

        // 🔥 STRICT PRIORITY ORDER
        if (desc.includes(keyword)) score += 100;
        if (campaign.includes(keyword)) score += 90;
        if (type.includes(keyword)) score += 80;
        if (subtype.includes(keyword)) score += 70;
        if (city.includes(keyword)) score += 60;
        if (location.includes(keyword)) score += 50;
        if (sublocation.includes(keyword)) score += 40;
        if (price.includes(keyword)) score += 30;
        if (ref.includes(keyword)) score += 20;

        // 🔹 Multi-word partial matching (AI feel)
        tokens.forEach((t) => {
          if (desc.includes(t)) score += 10;
          if (campaign.includes(t)) score += 9;
          if (type.includes(t)) score += 8;
          if (subtype.includes(t)) score += 7;
          if (city.includes(t)) score += 6;
          if (location.includes(t)) score += 5;
          if (sublocation.includes(t)) score += 4;
          if (price.includes(t)) score += 3;
          if (ref.includes(t)) score += 2;
        });

        return { ...c, _score: score };
      });

      // Highest relevance first
      customers.sort((a, b) => b._score - a._score);
    } */


    // --------------------------------------------
    // DEDUPLICATE BY CONTACTNUMBER ONLY IF NOT FILTERED BY ContactNumber
    // --------------------------------------------
    /*  if (!ContactNumber) {
       customers = deduplicateByContact(customers);
     } */

    /*     if (Limit !== undefined) {
          customers = customers.slice(0, Number(Limit));
        } */

    // --------------------------------------------
    // FINAL TRANSFORM
    // --------------------------------------------
    const transformed = await Promise.all(customers.map(transformGetCustomer));

    res.status(200).json(transformed);
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// ------------------------------------------------------
//               GET SINGLE CUSTOMER
// ------------------------------------------------------
export const getCustomerById = async (req, res, next) => {
  try {
    const admin = req.admin;
    const { id } = req.params;

    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) return next(new ApiError(404, "Customer not found"));

    // role: user → only if assigned to them
    if (admin.role === "user" && customer.AssignToId !== admin.id)
      return next(new ApiError(403, "Access denied"));

    // role: city_admin → only same city
    if (admin.role === "city_admin" && customer.City !== admin.city)
      return next(new ApiError(403, "Access denied"));

    const response = await transformCustomer(customer);
    res.status(200).json(response);
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// --------------------------------------------
// CHECK DUPLICATE CONTACT NUMBERS (BATCH)
// --------------------------------------------
export const checkDuplicateContacts = async (req, res) => {
  try {
    const { contactNumbers } = req.body;

    // सुरक्षा: ensure array exists
    if (!contactNumbers || !Array.isArray(contactNumbers)) {
      return res.status(400).json({
        success: false,
        message: "contactNumbers must be an array"
      });
    }

    // Remove empty/null & duplicates
    const uniqueNumbers = [...new Set(contactNumbers.filter(Boolean))];

    if (uniqueNumbers.length === 0) {
      return res.json({});
    }

    // Query DB
    const customers = await prisma.customer.findMany({
      where: {
        ContactNumber: {
          in: uniqueNumbers
        }
      },
      select: {
        ContactNumber: true,
        id: true
      }
    });

    // --------------------------------------------
    // Count occurrences
    // --------------------------------------------
    const countMap = {};

    for (const c of customers) {
      countMap[c.ContactNumber] = (countMap[c.ContactNumber] || 0) + 1;
    }

    // --------------------------------------------
    // Build response
    // --------------------------------------------
    const result = {};

    for (const num of uniqueNumbers) {
      result[num] = (countMap[num] || 0) > 1;
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error("checkDuplicateContacts Error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong"
    });
  }
};


// CREATE CUSTOMER
export const createCustomer = async (req, res, next) => {
  try {
    const admin = req.admin;
    const body = req.body;

    let CustomerImage = [];
    let SitePlan = [];

    if (req.files?.CustomerImage) {
      const uploads = req.files.CustomerImage.map((file) =>
        cloudinary.uploader
          .upload(file.path, {
            folder: "customer/customer_images",
            transformation: [{ width: 1000, crop: "limit" }],
          })
          .then((upload) => {
            fs.unlinkSync(file.path);
            return upload.secure_url;
          })
      );
      CustomerImage = await Promise.all(uploads);
    }

    if (req.files?.SitePlan) {
      const uploads = req.files.SitePlan.map((file) =>
        cloudinary.uploader
          .upload(file.path, {
            folder: "customer/site_plans",
            transformation: [{ width: 1000, crop: "limit" }],
          })
          .then((upload) => {
            fs.unlinkSync(file.path);
            return upload.secure_url;
          })
      );
      SitePlan = await Promise.all(uploads);
    }

    // --- Get active fields from master ---
    const activeFields = await prisma.customerFields.findMany({
      where: { Status: "Active" },
      select: { Name: true },
    });
    const allowedKeys = new Set(activeFields.map((f) => f.Name));

    const customerFieldsRaw = body.CustomerFields ? JSON.parse(body.CustomerFields) : {};
    // --- Build CustomerFields JSON ---
    const customerFieldsData = {};
    for (const key in customerFieldsRaw) {
      if (allowedKeys.has(key)) {
        customerFieldsData[key] = customerFieldsRaw[key];
      }
    }
    let PriceNumber = 0;
    /*     if (body.Price) {
          PriceNumber = Number(
            body.Price.toString().replace(/[^0-9.]/g, "")
          )
        } */


    if (body.Price) {
      const raw = body.Price.toString().toLowerCase();

      let multiplier = 1;
      if (raw.includes("thousand") || raw.includes("thousands") || raw.includes("हज़ार")) {
        multiplier = 1000;
      }
      else if (raw.includes("lakh") || raw.includes("लाख")) {
        multiplier = 100000;
      } else if (
        raw.includes("crore") ||
        raw.includes("करोड़") ||
        raw.includes("cr")
      ) {
        multiplier = 10000000;
      }

      PriceNumber =
        Number(raw.replace(/[^0-9.]/g, "")) * multiplier;
    }

    const newCustomer = await prisma.customer.create({
      data: {
        ...body,
        PriceNumber: PriceNumber,
        ClientId: admin.clientId,
        Email: body.Email || undefined,
        CustomerImage: JSON.stringify(CustomerImage),
        SitePlan: JSON.stringify(SitePlan),
        CustomerFields: customerFieldsData,
        AssignTo:
          admin.role === "user"
            ? {
              connect: [{ id: admin._id || admin.id }],
            }
            : undefined,
        CreatedById: admin._id || admin.id,
      },
    });

    /* web hook trigger n8n  */
    /*     const automationRes = await fetch("http://localhost:5678/webhook/customer-created", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            customerId: newCustomer.id,
            name: newCustomer.customerName,
            phone: newCustomer.ContactNumber
          })
        });
        console.log(" automation res is ", automationRes) */

    res
      .status(201)
      .json({ success: true, data: await transformCustomer(newCustomer) });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};


export const updateCustomer = async (req, res, next) => {
  try {
    const admin = req.admin;
    const { id } = req.params;

    let updateData = { ...req.body };

    // ✅ BOOLEAN PARSER ADDED
    const toBoolean = (val) => {
      if (val === undefined || val === null) return undefined;
      if (typeof val === "boolean") return val;
      if (typeof val === "string") {
        const lower = val.toLowerCase().trim();
        if (lower === "true") return true;
        if (lower === "false") return false;
      }
      return undefined;
    };

    // SAFE PARSE (unchanged)
    const safeParse = (value) => {
      if (value === undefined || value === null || value === "")
        return undefined;
      if (Array.isArray(value)) return value;
      try {
        return JSON.parse(value);
      } catch {
        return undefined;
      }
    };

    // PARSE FIELDS FROM FRONTEND
    updateData.CustomerImage = safeParse(updateData.CustomerImage);
    updateData.SitePlan = safeParse(updateData.SitePlan);

    updateData.removedCustomerImages =
      safeParse(updateData.removedCustomerImages) || [];

    updateData.removedSitePlans = safeParse(updateData.removedSitePlans) || [];

    // FETCH CUSTOMER
    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) return next(new ApiError(404, "Customer not found"));

    if (admin.role !== "administrator" && admin.clientId) {
      if (existing.ClientId !== admin.clientId) {
        return next(
          new ApiError(403, "You cannot modify another company's customer")
        );
      }
    }

    // --- Get active fields from master ---
    const activeFields = await prisma.customerFields.findMany({
      where: { Status: "Active" },
      select: { Name: true },
    });
    const allowedKeys = new Set(activeFields.map((f) => f.Name));

    // --- Build CustomerFields JSON from request ---
    const customerFieldsRaw = req.body.CustomerFields
      ? typeof req.body.CustomerFields === "string"
        ? JSON.parse(req.body.CustomerFields)
        : req.body.CustomerFields
      : {};

    // --- Merge with existing CustomerFields ---
    const existingCustomerFields = existing.CustomerFields || {};
    const mergedCustomerFields = {
      ...existingCustomerFields,
      ...Object.fromEntries(
        Object.entries(customerFieldsRaw).filter(([key]) =>
          allowedKeys.has(key)
        )
      ),
    };
    updateData.CustomerFields = mergedCustomerFields;


    // ROLE PERMISSIONS
    if (
      admin.role === "user" &&
      existing.AssignToId !== (admin._id || admin.id)
    ) {
      return next(new ApiError(403, "You can only update your own customers"));
    }

    if (admin.role === "city_admin" && existing.City !== admin.city) {
      return next(
        new ApiError(403, "You can only update customers in your city")
      );
    }

    // LOAD EXISTING IMAGES — FIXED
    let CustomerImage = safeParse(existing.CustomerImage) || [];
    let SitePlan = safeParse(existing.SitePlan) || [];

    if (typeof existing.CustomerImage === "string") {
      try {
        CustomerImage = JSON.parse(existing.CustomerImage);
      } catch {
        CustomerImage = [];
      }
    }
    if (typeof existing.SitePlan === "string") {
      try {
        SitePlan = JSON.parse(existing.SitePlan);
      } catch {
        SitePlan = [];
      }
    }

    // REMOVE SPECIFIC CUSTOMER IMAGES
    if (updateData.removedCustomerImages.length > 0) {
      await Promise.all(
        updateData.removedCustomerImages.map((url) => {
          const publicId = getPublicIdFromUrl(url);
          if (publicId)
            return cloudinary.uploader.destroy(
              `customer/customer_images/${publicId}`
            );
        })
      );

      CustomerImage = CustomerImage.filter(
        (img) => !updateData.removedCustomerImages.includes(img)
      );
    }

    // REMOVE SPECIFIC SITE PLANS
    if (updateData.removedSitePlans.length > 0) {
      await Promise.all(
        updateData.removedSitePlans.map((url) => {
          const publicId = getPublicIdFromUrl(url);
          if (publicId)
            return cloudinary.uploader.destroy(
              `customer/site_plans/${publicId}`
            );
        })
      );

      SitePlan = SitePlan.filter(
        (img) => !updateData.removedSitePlans.includes(img)
      );
    }

    // REMOVE ALL CUSTOMER IMAGES
    if (
      updateData.CustomerImage !== undefined &&
      Array.isArray(updateData.CustomerImage) &&
      updateData.CustomerImage.length === 0
    ) {
      await Promise.all(
        CustomerImage.map((url) => {
          const publicId = getPublicIdFromUrl(url);
          if (publicId)
            return cloudinary.uploader.destroy(
              `customer/customer_images/${publicId}`
            );
        })
      );
      CustomerImage = [];
    }

    // REMOVE ALL SITE PLANS
    if (
      updateData.SitePlan !== undefined &&
      Array.isArray(updateData.SitePlan) &&
      updateData.SitePlan.length === 0
    ) {
      await Promise.all(
        SitePlan.map((url) => {
          const publicId = getPublicIdFromUrl(url);
          if (publicId)
            return cloudinary.uploader.destroy(
              `customer/site_plans/${publicId}`
            );
        })
      );
      SitePlan = [];
    }

    // UPLOAD NEW CUSTOMER IMAGES
    if (req.files?.CustomerImage) {
      const uploads = req.files.CustomerImage.map((file) =>
        cloudinary.uploader
          .upload(file.path, {
            folder: "customer/customer_images",
            transformation: [{ width: 1000, crop: "limit" }],
          })
          .then((upload) => {
            fs.unlinkSync(file.path);
            return upload.secure_url;
          })
      );

      CustomerImage.push(...(await Promise.all(uploads)));
    }

    // UPLOAD NEW SITE PLANS
    if (req.files?.SitePlan) {
      const uploads = req.files.SitePlan.map((file) =>
        cloudinary.uploader
          .upload(file.path, {
            folder: "customer/site_plans",
            transformation: [{ width: 1000, crop: "limit" }],
          })
          .then((upload) => {
            fs.unlinkSync(file.path);
            return upload.secure_url;
          })
      );

      SitePlan.push(...(await Promise.all(uploads)));
    }

    // SAVE FINAL IMAGE ARRAYS
    updateData.CustomerImage = JSON.stringify(CustomerImage);
    updateData.SitePlan = JSON.stringify(SitePlan);

    // Fix null relations
    if (updateData.AssignToId === "") updateData.AssignToId = null;
    if (updateData.CreatedById === "") updateData.CreatedById = null;

    // REMOVE NON-DB KEYS
    delete updateData.removedCustomerImages;
    delete updateData.removedSitePlans;
    delete updateData["removedCustomerImages "];
    delete updateData["removedSitePlans "];

    // ✅ BOOLEAN FIX — JUST THIS LINE
    updateData.isFavourite = toBoolean(updateData.isFavourite);
    updateData.isChecked = toBoolean(updateData.isChecked)

    const onlyIsChecked = Object.keys(req.body).length === 1 && 'isChecked' in req.body;

    if (!onlyIsChecked) {
      updateData.updatedAt = new Date(); // force updatedAt to change
    }

    /*     if (updateData.Price) {
          const PriceNumber = Number(
            updateData.Price.toString().replace(/[^0-9.]/g, "")
          )
    
          updateData.PriceNumber = PriceNumber;
        } */

    if (updateData.Price) {
      let raw = updateData.Price.toString().toLowerCase();

      let multiplier = 1;
      if (raw.includes("thousand") || raw.includes("thousands") || raw.includes("हज़ार")) {
        multiplier = 1000;
      }
      else if (raw.includes("crore") || raw.includes("cr")) {
        multiplier = 10000000;
      } else if (raw.includes("lakh") || raw.includes("lac") || raw.includes("l")) {
        multiplier = 100000;
      }

      const PriceNumber =
        Number(raw.replace(/[^0-9.]/g, "")) * multiplier;

      updateData.PriceNumber = PriceNumber;
    }

    // UPDATE CUSTOMER
    const updated = await prisma.customer.update({
      where: { id },
      data: updateData,
    });

    res.status(200).json({
      success: true,
      message: "Customer updated successfully",
      data: await transformGetCustomer(updated),
    });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// DELETE CUSTOMER
export const deleteCustomer = async (req, res, next) => {
  try {
    const admin = req.admin;
    const { id } = req.params;

    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) return next(new ApiError(404, "Customer not found"));

    /*     if (admin.role !== "administrator") {
          if (existing.ClientId !== admin.clientId) {
            return next(
              new ApiError(403, "You cannot delete another company's customer")
            );
          }
        } */

    if (
      admin.role === "user" &&
      existing.AssignToId !== (admin._id || admin.id)
    )
      return next(new ApiError(403, "You can only delete your own customers"));
    if (admin.role === "city_admin" && existing.City !== admin.city)
      return next(
        new ApiError(403, "You can only delete customers in your city")
      );

    const CustomerImage = parseJSON(existing.CustomerImage);
    const SitePlan = parseJSON(existing.SitePlan);

    const deletions = [
      ...CustomerImage.map((url) =>
        cloudinary.uploader.destroy(
          `customer/customer_images/${getPublicIdFromUrl(url)}`
        )
      ),
      ...SitePlan.map((url) =>
        cloudinary.uploader.destroy(
          `customer/site_plans/${getPublicIdFromUrl(url)}`
        )
      ),
    ];

    await Promise.allSettled(deletions);

    await prisma.customer.delete({ where: { id } });

    res.status(200).json({ message: "Customer deleted successfully" });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// ASSIGN CUSTOMERS
// ASSIGN CUSTOMERS (ID or Campaign Based)
export const assignCustomer = async (req, res, next) => {
  try {
    const { customerIds = [], assignToId, campaign } = req.body;
    const admin = req.admin;

    if (!assignToId || !Array.isArray(assignToId) || assignToId.length === 0)
      return next(new ApiError(400, "assignToId is required"));

    // get admins
    const assignToAdmin = await prisma.admin.findMany({
      where: {
        id: { in: assignToId },
      },
      select: {
        id: true,
        role: true,
        clientId: true,
        city: true,
      },
    });

    if (!assignToAdmin || assignToAdmin.length === 0)
      return next(new ApiError(404, "Admin/User not found"));

    // ------------------------------------------------
    //  RESTRICTION: USER can only get selected IDs
    // ------------------------------------------------
    const hasUser = assignToAdmin.some((a) => a.role === "user");

    if (hasUser) {
      if (!customerIds.length || campaign) {
        return next(
          new ApiError(
            403,
            "You can only assign selected customers to a user"
          )
        );
      }
    }

    if (customerIds.length && campaign) {
      return next(
        new ApiError(400, "Provide either customerIds or campaign, not both")
      );
    }

    if (admin.role !== "administrator") {
      const invalidAdmin = assignToAdmin.find(
        (a) => a.clientId !== admin.clientId
      );

      if (invalidAdmin) {
        return next(
          new ApiError(
            403,
            "You cannot assign customers to another company admin"
          )
        );
      }
    }

    // ------------------------------------------------
    // BUILD FILTER
    // ------------------------------------------------
    let whereCondition = {};

    if (admin.role !== "administrator") {
      whereCondition.ClientId = admin.clientId;
    }

    if (customerIds.length > 0) {
      whereCondition.id = { in: customerIds };
    }

    if (campaign) {
      whereCondition.Campaign = campaign;
    }

    if (customerIds.length === 0 && !campaign)
      return next(new ApiError(400, "Provide customerIds or campaign"));

    const customers = await prisma.customer.findMany({
      where: whereCondition,
      include: {
        AssignTo: true,
      },
    });

    if (customers.length === 0)
      return next(new ApiError(404, "No valid customers found"));

    // ------------------------------------------------
    // ROLE VALIDATION (Logged-in Admin Rules)
    // ------------------------------------------------
    if (admin.role === "city_admin") {
      const invalid = customers.filter((c) => c.City !== admin.city);

      if (invalid.length > 0)
        return next(
          new ApiError(403, "You can only assign customers in your city")
        );

      const invalidAssign = assignToAdmin.find((a) => a.city !== admin.city);

      if (invalidAssign)
        return next(
          new ApiError(403, "You can only assign to users in your city")
        );
    } else if (admin.role === "user") {
      return next(
        new ApiError(403, "Users are not allowed to assign customers")
      );
    }

    // ------------------------------------------------
    // UPDATE
    // ------------------------------------------------
    const updates = [];

    for (const customer of customers) {
      updates.push(
        prisma.customer.update({
          where: { id: customer.id },
          data: {
            AssignTo: {
              connect: assignToId.map((id) => ({ id })),
            }
          },
        })
      );
    }

    await Promise.all(updates);

    const updated = await prisma.customer.findMany({
      where: whereCondition,
      include: {
        AssignTo: true,
      },
    });

    res.status(200).json({
      success: true,
      message: `Assigned ${updated.length} customers successfully`,
      data: await Promise.all(updated.map(transformGetCustomer)),
    });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// BULK ASSIGN CITY CUSTOMERS
export const bulkAssignCityCustomers = async (req, res, next) => {
  try {
    const admin = req.admin;
    const { assignToId } = req.body;
    if (admin.role !== "city_admin")
      return next(
        new ApiError(403, "Only City Admin can assign all city customers")
      );

    const targetAdmin = await prisma.admin.findUnique({
      where: { id: assignToId },
    });
    if (!targetAdmin)
      return next(new ApiError(404, "Target user/admin not found"));
    if (targetAdmin.city !== admin.city)
      return next(
        new ApiError(403, "You can only assign to users in your city")
      );

    const result = await prisma.customer.updateMany({
      where: { City: admin.city },
      data: { AssignToId: assignToId },
    });

    res.status(200).json({
      success: true,
      message: `Assigned ${result.count} customers to ${targetAdmin.name}`,
    });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// GET FAVOURITES
export const getFavouriteCustomers = async (req, res, next) => {
  try {
    const admin = req.admin;
    let where = { isFavourite: true };


    if (admin.role !== "administrator" && admin.clientId) {
      where.ClientId = admin.clientId;
    }
    /* if (admin.role === "city_admin")
      where.City = { contains: admin.city, mode: "insensitive" };
    else if (admin.role === "user") where.AssignToId = admin._id || admin.id; */

    const favs = await prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    const transformed = await Promise.all(favs.map(transformGetCustomer));
    res
      .status(200)
      .json({ success: true, count: transformed.length, data: transformed });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// ✅ DELETE SELECTED OR ALL CUSTOMERS (Prisma version, same logic as MongoDB)
export const deleteAllCustomers = async (req, res, next) => {
  try {
    const admin = req.admin;
    if (admin.role !== "administrator")
      return next(new ApiError(403, "Only administrator can delete customers"));

    const { customerIds } = req.body;

    // Normalize IDs (string → array)
    let ids = customerIds;
    if (typeof ids === "string") {
      try {
        ids = JSON.parse(ids);
      } catch {
        ids = [];
      }
    }
    if (!Array.isArray(ids)) ids = [];

    let customersToDelete = [];

    if (ids.length > 0) {
      customersToDelete = await prisma.customer.findMany({
        where: { id: { in: ids } },
      });
      if (customersToDelete.length === 0)
        return next(new ApiError(404, "No valid customers found"));
    } else {
      customersToDelete = await prisma.customer.findMany();
      if (customersToDelete.length === 0)
        return next(new ApiError(404, "No customers found to delete"));
    }

    const deletions = [];

    for (const c of customersToDelete) {
      const CustomerImage = parseJSON(c.CustomerImage);
      const SitePlan = parseJSON(c.SitePlan);

      if (CustomerImage?.length) {
        deletions.push(
          ...CustomerImage.map((url) =>
            cloudinary.uploader.destroy(
              `customer/customer_images/${getPublicIdFromUrl(url)}`
            )
          )
        );
      }

      if (SitePlan?.length) {
        deletions.push(
          ...SitePlan.map((url) =>
            cloudinary.uploader.destroy(
              `customer/site_plans/${getPublicIdFromUrl(url)}`
            )
          )
        );
      }
    }

    await Promise.allSettled(deletions);

    // ======================================================
    // ✔ CORRECT FIX — delete Followups only
    // ======================================================
    if (ids.length > 0) {
      await prisma.followup.deleteMany({
        where: { customerId: { in: ids } },
      });
    } else {
      await prisma.followup.deleteMany({});
    }

    // Delete customers
    if (ids.length > 0) {
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    } else {
      await prisma.customer.deleteMany({});
    }

    res.status(200).json({
      success: true,
      message:
        ids.length > 0
          ? "Selected customers deleted successfully"
          : "All customers deleted successfully",
      deletedCustomerIds:
        ids.length > 0 ? ids : customersToDelete.map((c) => c.id),
    });
  } catch (error) {
    console.error("❌ DeleteAllCustomers Error:", error);
    next(new ApiError(500, error.message));
  }
};


// ------------------------------------------------------
//               RECOMMEND CUSTOMER (AI-AGENT)
// ------------------------------------------------------

export const getRecommendedCustomer = async (req, res, next) => {
  try {
    const admin = req.admin;
    const { userPrompt, customerId } = req.body;

    if (!userPrompt) {
      return next(new ApiError(400, "userPrompt is required"));
    }

    if (!customerId) {
      return next(new ApiError(400, "customerId is required"));
    }

    // --------------------------------------------
    // 🔥 GET BASE CUSTOMER (LIKE QUALIFY FLOW)
    // --------------------------------------------

    const baseCustomer = await prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!baseCustomer) {
      return next(new ApiError(404, "Customer not found"));
    }

    const followups = await prisma.followup.findMany({
      where: { customerId },
      orderBy: { createdAt: "asc" },
    });

    // --------------------------------------------
    // 🔥 AI FILTER GENERATION (MAIN CHANGE)
    // --------------------------------------------

    const { tokens, fields, priceRange, answer } =
      await getRecommendedKeywordSearchData(
        userPrompt,
        baseCustomer,
        followups
      );

    let AND = [];

    // --------------------------------------------
    // ROLE-BASED FILTERS (UNCHANGED)
    // --------------------------------------------

    if (admin.role !== "administrator" && admin.clientId) {
      AND.push({
        OR: [
          { ClientId: admin.clientId },
          { CreatedById: admin.id || admin._id }
        ]
      });
    }

    if (admin.role === "user") {
      const adminId = admin.id || admin._id;

      AND.push({
        OR: [
          {
            AssignTo: {
              some: { id: adminId }
            }
          },
          {
            CreatedById: adminId
          }
        ]
      });
    }

    else if (admin.role === "city_admin") {
      const adminId = admin.id || admin._id;

      const assignedCampaignsData = await prisma.customer.findMany({
        where: {
          AssignTo: {
            some: { id: adminId }
          }
        },
        select: { Campaign: true },
        distinct: ["Campaign"]
      });

      const assignedCampaigns = assignedCampaignsData
        .map(c => c.Campaign)
        .filter(Boolean);

      AND.push({
        OR: [
          { CreatedById: adminId },
          {
            AND: [
              { AssignTo: { some: { id: adminId } } },
              { City: { contains: admin.city } }
            ]
          },
          ...(assignedCampaigns.length > 0
            ? [{
              AND: [
                { Campaign: { in: assignedCampaigns } },
                { City: { contains: admin.city } }
              ]
            }]
            : [])
        ]
      });
    }

    // --------------------------------------------
    // 🔥 APPLY AI FILTERS (SMART)
    // --------------------------------------------

    if (tokens.length > 0) {
      AND.push({
        AND: tokens.map((t) => ({
          OR: fields.map((field) => ({
            [field]: { contains: t },
          })),
        })),
      });
    }

    if (priceRange?.min || priceRange?.max) {
      const min = priceRange?.min !== null
        ? Number(String(priceRange.min).replace(/[^0-9]/g, ""))
        : null;

      const max = priceRange?.max !== null
        ? Number(String(priceRange.max).replace(/[^0-9]/g, ""))
        : null;

      if (!isNaN(min) || !isNaN(max)) {
        AND.push({
          PriceNumber: {
            ...(min !== null && !isNaN(min) && { gte: min }),
            ...(max !== null && !isNaN(max) && { lte: max }),
          }
        });
      }
    }

    const where = AND.length ? { AND } : {};

    // --------------------------------------------
    // FETCH MATCHING CUSTOMERS
    // --------------------------------------------

    let customers = await prisma.customer.findMany({
      where,
      orderBy: [
        { updatedAt: "desc" },
        { createdAt: "desc" }
      ],
      distinct: ["ContactNumber"],
      include: { AssignTo: true }
    });

    // --------------------------------------------
    // SORT
    // --------------------------------------------

    customers.sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt).getTime();
      return bTime - aTime;
    });

    // --------------------------------------------
    // TRANSFORM
    // --------------------------------------------

    const transformed = await Promise.all(
      customers.map(transformGetCustomer)
    );

    res.status(200).json({
      success: true,
      count: transformed.length,
      data: transformed,
      aiAnswer: answer,
      appliedFilters: {
        tokens,
        fields,
        priceRange
      }
    });

  } catch (error) {
    next(new ApiError(500, error.message));
  }
};


// lead qualification agent

export const qualifyCustomer = async (req, res, next) => {
  try {
    const { userPrompt, customerId } = req.body;

    if (!userPrompt) {
      return next(new ApiError(400, "userPrompt is required"));
    }
    if (!customerId) {
      return next(new ApiError(400, "customerId is required"));
    }

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      return next(new ApiError(404, "Customer not found"));
    }

    const followups = await prisma.followup.findMany({
      where: { customerId },
      orderBy: { createdAt: "asc" },
    });

    const userMessage = {
      customer: {
        name: customer.customerName,
        description: customer.Description,
        price: customer.PriceNumber,
        location: customer.Location,
      },
      followups: followups.map((f) => ({
        description: f.Description,
        startdate: f.StartDate,
        followupNextDate: f.FollowupNextDate,
        status: f.Status,
      })),
      userPrompt,
    }
    console.log("User message for agent:", JSON.stringify(userMessage, null, 2));
    const agentResponse = await QualifyAgent(userMessage);
    console.log("Agent response:", JSON.stringify(agentResponse, null, 2));

    // Call the agent function

    //dummy response
    res.status(200).json({
      success: true,
      message: "Customer qualified successfully",
      data: agentResponse,
    });

  }
  catch (error) {
    next(new ApiError(500, error.message));
  }
}

// data mining agent

export const dataMining = async (req, res, next) => {
  try {
    const now = new Date();

    const last7Days = new Date();
    last7Days.setDate(now.getDate() - 7);

    const last30Days = new Date();
    last30Days.setDate(now.getDate() - 30);

    // ================================
    // 1. TOTAL METRICS
    // ================================
    const [totalLeads7d, totalLeads30d, totalConversions7d] =
      await Promise.all([
        prisma.customer.count({
          where: { createdAt: { gte: last7Days } }
        }),
        prisma.customer.count({
          where: { createdAt: { gte: last30Days } }
        }),
        prisma.customer.count({
          where: {
            LeadTemperature: "hot",
            createdAt: { gte: last7Days }
          }
        })
      ]);

    const conversionRate =
      totalLeads7d > 0
        ? ((totalConversions7d / totalLeads7d) * 100).toFixed(2)
        : 0;

    // ================================
    // 2. CAMPAIGN PERFORMANCE (TOP 5)
    // ================================
    const [leadsByCampaign, conversionsByCampaign] =
      await Promise.all([
        prisma.customer.groupBy({
          by: ["Campaign"],
          where: { createdAt: { gte: last7Days } },
          _count: { id: true }
        }),
        prisma.customer.groupBy({
          by: ["Campaign"],
          where: {
            LeadTemperature: "hot",
            createdAt: { gte: last7Days }
          },
          _count: { id: true }
        })
      ]);

    const topCampaigns = leadsByCampaign
      .sort((a, b) => b._count.id - a._count.id)
      .slice(0, 5);

    const topConversions = conversionsByCampaign
      .sort((a, b) => b._count.id - a._count.id)
      .slice(0, 5);

    // ================================
    // 3. TOP CITIES (LIMITED)
    // ================================
    const leadsByCityRaw = await prisma.customer.groupBy({
      by: ["City"],
      where: { createdAt: { gte: last30Days } },
      _count: { id: true }
    });

    const topCities = leadsByCityRaw
      .sort((a, b) => b._count.id - a._count.id)
      .slice(0, 5);

    // ================================
    // 4. FUNNEL (COMPRESSED)
    // ================================
    const funnelRaw = await prisma.customer.groupBy({
      by: ["LeadTemperature"],
      _count: { id: true }
    });

    const funnel = {
      hot: 0,
      warm: 0,
      cold: 0
    };

    funnelRaw.forEach(f => {
      if (f.LeadTemperature === "hot") funnel.hot = f._count.id;
      if (f.LeadTemperature === "warm") funnel.warm = f._count.id;
      if (f.LeadTemperature === "cold") funnel.cold = f._count.id;
    });

    // ================================
    // 5. ENGAGEMENT (AGGREGATED ONLY)
    // ================================
    const [totalFollowups, totalCalls] = await Promise.all([
      prisma.followup.count({
        where: { createdAt: { gte: last7Days } }
      }),
      prisma.callLog.count({
        where: { createdAt: { gte: last7Days } }
      })
    ]);

    const avgFollowupsPerLead =
      totalLeads7d > 0
        ? (totalFollowups / totalLeads7d).toFixed(2)
        : 0;

    const avgCallsPerLead =
      totalLeads7d > 0
        ? (totalCalls / totalLeads7d).toFixed(2)
        : 0;

    // ================================
    // 6. BUDGET SEGMENTATION
    // ================================
    const budgets = await prisma.customer.findMany({
      where: { PriceNumber: { not: null } },
      select: { PriceNumber: true }
    });

    const budgetSegments = {
      "0-20L": 0,
      "20L-50L": 0,
      "50L-1Cr": 0,
      "1Cr+": 0
    };

    budgets.forEach(b => {
      const p = b.PriceNumber;
      if (p <= 2000000) budgetSegments["0-20L"]++;
      else if (p <= 5000000) budgetSegments["20L-50L"]++;
      else if (p <= 10000000) budgetSegments["50L-1Cr"]++;
      else budgetSegments["1Cr+"]++;
    });

    // ================================
    // FINAL AI INPUT (OPTIMIZED)
    // ================================
    const miningInput = {
      totals: {
        last7Days: {
          totalLeads: totalLeads7d,
          totalConversions: totalConversions7d,
          conversionRate
        },
        last30Days: {
          totalLeads: totalLeads30d
        }
      },

      campaigns: {
        topLeads: topCampaigns,
        topConversions: topConversions
      },

      locations: topCities,

      funnel,

      engagement: {
        avgFollowupsPerLead,
        avgCallsPerLead
      },

      budget: budgetSegments
    };

    console.log("AI Input:", JSON.stringify(miningInput, null, 2));

    const agentResponse = await DataMiningAgent(miningInput);

    res.status(200).json({
      success: true,
      data: agentResponse
    });

  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

export const startCall = async (req, res) => {
  try {
    const { userPrompt, customerId } = req.body;

    if (!userPrompt) {
      return next(new ApiError(400, "userPrompt is required"));
    }

    if (!customerId) {
      return next(new ApiError(400, "customerId is required"));
    }

    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    });



    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    const followups = await prisma.followup.findMany({
      where: { customerId },
      orderBy: { createdAt: "asc" },
    });
    const userMessage = {
      customer: {
        name: customer.customerName,
        description: customer.Description,
        price: customer.PriceNumber,
        city: customer.City,
        location: customer.Location,
        campaign: customer.Campaign,
        customertype: customer.CustomerType,
        customersubtype: customer.CustomerSubType,
      },
      followups: followups.map((f) => ({
        description: f.Description,
        startdate: f.StartDate,
        followupNextDate: f.FollowupNextDate,
        status: f.Status,
      })),
      userPrompt,
    }

    const agentResponse = await CallingAgent(userMessage);
    /* console.log("Agent response for call instructions:", JSON.stringify(agentResponse, null, 2)); */

    const response = await fetch("https://www.tabbly.io/dashboard/agents/endpoints/trigger-call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.TAPPLY_API_KEY}` // ✅ HERE
      },
      body: JSON.stringify({
        organization_id: process.env.TAPPLY_ORG_ID,
        use_agent_id: process.env.TAPPLY_CALL_AGENT_ID,
        called_to: `+91${customer.ContactNumber}`,
        call_from: `${process.env.TAPPLY_CALLER_NUMBER}`,
        custom_first_line: "",
        custom_instruction: agentResponse.callingPrompt,
        api_key: process.env.TAPPLY_API_KEY,
        custom_identifiers: "",
      })
    });

    const data = await response.json();

    if (data.success) {
      await prisma.callLog.create({
        data: {
          participantIdentity: data.participant_identity,
        }
      });
    }


    return res.status(200).json({
      success: true,
      message: "Call instructions generated successfully",
      data: agentResponse,
      callingdata: data
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Call failed" });
  }
};


export const getCallLogs = async (req, res) => {
  try {
    const response = await fetch(
      `https://www.tabbly.io/dashboard/agents/endpoints/call-logs-v2?api_key=${process.env.TAPPLY_API_KEY}&organization_id=2454`, // ⚠️ replace with real endpoint
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        }
      }
    );

    //console.log("STATUS:", response.status);

    const text = await response.text();
    // console.log("RAW RESPONSE:", text);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({
        message: "Invalid JSON from Tapply",
        raw: text
      });
    }

    return res.json(data);

  } catch (error) {
    console.log("ERROR:", error);
    return res.status(500).json({
      message: "Failed to fetch call logs"
    });
  }
};




export const getCallReport = async (req, res, next) => {
  try {
    const { keyword, limit } = req.query;

    let where = {};

    if (keyword) {
      where.Name = { contains: keyword, mode: "insensitive" };
    }

    const report = await prisma.callLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit ? Number(limit) : undefined,
    });
    res.status(200).json({
      success: true,
      count: report.length,
      data: report,
    });
  }
  catch (error) {
    next(new ApiError(500, error.message));
  }
}

export const deleteCallLogById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ message: "ID is required" });
    }

    const deletedLog = await prisma.callLog.delete({
      where: {
        id: String(id), // adjust if your id is number
      },
    });

    return res.status(200).json({
      message: "Call log deleted successfully",
      data: deletedLog,
    });
  } catch (error) {
    console.error("Delete by ID error:", error);

    // Prisma specific error (record not found)
    if (error.code === "P2025") {
      return res.status(404).json({ message: "Call log not found" });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};


export const syncCallLogs = async (req, res) => {
  try {
    const response = await fetch(
      `https://www.tabbly.io/dashboard/agents/endpoints/call-logs-v2?api_key=${process.env.TAPPLY_API_KEY}&organization_id=2454`
    );

    const data = await response.json();

    if (!data?.data) {
      return res.status(400).json({ message: "Invalid Tabbly response" });
    }

    for (const log of data.data) {
      const normalizedPhone = log.called_to?.slice(-10);

      await prisma.callLog.upsert({
        where: {
          participantIdentity: log.participant_identity,
        },

        update: {
          agentId: log.use_agent_id,
          organizationId: String(log.organization_id),

          calledTo: log.called_to,
          normalizedPhone,

          callDirection: log.call_direction,
          callStatus: log.call_status,
          callDuration: log.call_duration || 0,

          startTime: log.start_time ? new Date(log.start_time) : null,
          endTime: log.end_time ? new Date(log.end_time) : null,
          calledTime: log.created_at ? new Date(log.created_at) : null,

          recordingUrl: log.recording_url,

          transcript: log.transcript,
          summary: log.summary,
          sentiment: log.sentiment,

          totalCallCost: log.total_cost,
          telcoPricing: log.telco_cost,
          agentCost: log.agent_cost,

          rawJson: log,
        },

        create: {
          participantIdentity: log.participant_identity,

          agentId: log.use_agent_id,
          organizationId: String(log.organization_id),

          calledTo: log.called_to,
          normalizedPhone,

          callDirection: log.call_direction,
          callStatus: log.call_status,
          callDuration: log.call_duration || 0,

          startTime: log.start_time ? new Date(log.start_time) : null,
          endTime: log.end_time ? new Date(log.end_time) : null,
          calledTime: log.created_at ? new Date(log.created_at) : null,

          recordingUrl: log.recording_url,

          transcript: log.transcript,
          summary: log.summary,
          sentiment: log.sentiment,

          totalCallCost: log.total_cost,
          telcoPricing: log.telco_cost,
          agentCost: log.agent_cost,

          rawJson: log,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Call logs synced successfully",
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Sync failed",
    });
  }
};