import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";
import fs from "fs";
import cloudinary from "../config/cloudinary.js";
import { getKeywordSearchData } from "../ai/getKeywordSearchData.js";

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
    AssignTo: assignToDoc
      ? {
        _id: assignToDoc.id,
        name: assignToDoc.name,
        email: assignToDoc.email,
        role: assignToDoc.role,
        city: assignToDoc.city,
      }
      : null,
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
//               GET CUSTOMERS
// ------------------------------------------------------
export const getCustomer = async (req, res, next) => {
  try {
    const admin = req.admin;

    const {
      Campaign,
      CustomerType,
      CustomerSubType,
      StatusType,
      City,
      Location,
      Keyword,
      SearchIn,
      ReferenceId,
      Price,
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
    if (admin.role === "city_admin") {
      AND.push({ City: { contains: admin.city } });
    } else if (admin.role === "user") {
      AND.push({ AssignToId: admin.id || admin._id });
    }

    // --------------------------------------------
    // BASIC FILTERS
    // --------------------------------------------
    if (Campaign) AND.push({ Campaign: { contains: Campaign.trim() } });

    if (CustomerType)
      AND.push({ CustomerType: { contains: CustomerType.trim() } });

    if (CustomerSubType)
      AND.push({ CustomerSubType: { contains: CustomerSubType.trim() } });

    if (StatusType) AND.push({ Verified: { contains: StatusType.trim() } });

    if (City) AND.push({ City: { contains: City.trim() } });

    if (Location) AND.push({ Location: { contains: Location.trim() } });
    if (ContactNumber) AND.push({ ContactNumber: { contains: ContactNumber.trim() } });
    if (ReferenceId) AND.push({ ReferenceId: { contains: ReferenceId.trim() } });
    if (Price) AND.push({ Price: { contains: Price.trim() } });

    // --------------------------------------------
    // KEYWORD SEARCH
    // --------------------------------------------
    const keyword = Keyword?.trim();

    if (keyword) {
      const { tokens, fields } = await getKeywordSearchData(keyword);

      AND.push({
        AND: tokens.map((t) => ({
          OR: fields.map((field) => ({
            [field]: { contains: t },
          })),
        })),
      });
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
    const totalRecords = await prisma.customer.count({ where });

    // --------------------------------------------
    // MAIN PRISMA FETCH
    // --------------------------------------------

    let customers;

    if (Limit !== undefined) {
      // If Limit is provided → over-fetch to guarantee enough after JS filters
      const REQUIRED = Number(Limit);
      const FETCH_MULTIPLIER = 3;

      customers = await prisma.customer.findMany({
        where,
        orderBy,
        skip: offset,
        take: REQUIRED * FETCH_MULTIPLIER,
      });
    } else {
      // If Limit is NOT provided → behave as old flow (fetch all / default DB behavior)
      customers = await prisma.customer.findMany({
        where,
        orderBy,
        skip: offset,
      });
    }


    // --------------------------------------------
    // POST-FETCH FILTER BY CustomerDate (dd-mm-yyyy) ONLY IF BOTH START AND END PROVIDED
    // --------------------------------------------
    if (StartDate && EndDate) {
      const [sdDay, sdMonth, sdYear] = StartDate.split("-").map(Number);
      const [edDay, edMonth, edYear] = EndDate.split("-").map(Number);

      const start = new Date(sdYear, sdMonth - 1, sdDay, 0, 0, 0, 0);
      const end = new Date(edYear, edMonth - 1, edDay, 23, 59, 59, 999);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        customers = customers.filter((c) => {
          if (c.CustomerDate && c.CustomerDate.trim() !== "") {
            const parts = c.CustomerDate.split("-");
            let custDate;

            if (parts.length === 3) {
              // Check which format it is
              if (parts[0].length === 4) {
                // yyyy-mm-dd
                const [yyyy, mm, dd] = parts.map(Number);
                custDate = new Date(yyyy, mm - 1, dd);
              } else {
                // dd-mm-yyyy
                const [dd, mm, yyyy] = parts.map(Number);
                custDate = new Date(yyyy, mm - 1, dd);
              }
            } else {
              custDate = new Date(c.CustomerDate);
            }

            return !isNaN(custDate.getTime()) && custDate >= start && custDate <= end;
          }

          // If CustomerDate is empty, do NOT include
          return false;
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
        (c) => c.AssignToId && allowedIds.includes(c.AssignToId)
      );

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
    if (!ContactNumber) {
      customers = deduplicateByContact(customers);
    }

    if (Limit !== undefined) {
      customers = customers.slice(0, Number(Limit));
    }

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
    const newCustomer = await prisma.customer.create({
      data: {
        ...body,
        Email: body.Email || undefined,
        CustomerImage: JSON.stringify(CustomerImage),
        SitePlan: JSON.stringify(SitePlan),
        CustomerFields: customerFieldsData,
        AssignToId: admin.role === "user" ? admin._id || admin.id : undefined,
        CreatedById: admin._id || admin.id,
      },
    });

    res
      .status(201)
      .json({ success: true, data: await transformCustomer(newCustomer) });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// UPDATE CUSTOMER
// export const updateCustomer = async (req, res, next) => {
//   try {
//     const admin = req.admin;
//     const { id } = req.params;

//     let updateData = { ...req.body };

//     // SAFE PARSE (unchanged)
//     const safeParse = (value) => {
//       if (value === undefined || value === null || value === "")
//         return undefined;
//       if (Array.isArray(value)) return value;
//       try {
//         return JSON.parse(value);
//       } catch {
//         return undefined;
//       }
//     };

//     // PARSE FIELDS FROM FRONTEND
//     updateData.CustomerImage = safeParse(updateData.CustomerImage);
//     updateData.SitePlan = safeParse(updateData.SitePlan);

//     updateData.removedCustomerImages =
//       safeParse(updateData.removedCustomerImages) || [];

//     updateData.removedSitePlans = safeParse(updateData.removedSitePlans) || [];

//     // FETCH CUSTOMER
//     const existing = await prisma.customer.findUnique({ where: { id } });
//     if (!existing) return next(new ApiError(404, "Customer not found"));

//     // ROLE PERMISSIONS
//     if (
//       admin.role === "user" &&
//       existing.AssignToId !== (admin._id || admin.id)
//     ) {
//       return next(new ApiError(403, "You can only update your own customers"));
//     }

//     if (admin.role === "city_admin" && existing.City !== admin.city) {
//       return next(
//         new ApiError(403, "You can only update customers in your city")
//       );
//     }

//     // LOAD EXISTING IMAGES — FIXED
//     let CustomerImage = safeParse(existing.CustomerImage) || [];
//     let SitePlan = safeParse(existing.SitePlan) || [];

//     // ❌ FIX #1 — Your old code: safeParse(existing.CustomerImage)
//     // Prisma returns a **string**, safeParse → undefined → ARRAY LOST.
//     // So removal never worked because CustomerImage = [] always.
//     //
//     // New behavior parses JSON safely:
//     if (typeof existing.CustomerImage === "string") {
//       try {
//         CustomerImage = JSON.parse(existing.CustomerImage);
//       } catch {
//         CustomerImage = [];
//       }
//     }
//     if (typeof existing.SitePlan === "string") {
//       try {
//         SitePlan = JSON.parse(existing.SitePlan);
//       } catch {
//         SitePlan = [];
//       }
//     }

//     // REMOVE SPECIFIC CUSTOMER IMAGES
//     if (updateData.removedCustomerImages.length > 0) {
//       await Promise.all(
//         updateData.removedCustomerImages.map((url) => {
//           const publicId = getPublicIdFromUrl(url);
//           if (publicId)
//             return cloudinary.uploader.destroy(
//               `customer/customer_images/${publicId}`
//             );
//         })
//       );

//       // FIXED — compare strings correctly
//       CustomerImage = CustomerImage.filter(
//         (img) => !updateData.removedCustomerImages.includes(img)
//       );
//     }

//     // REMOVE SPECIFIC SITE PLANS
//     if (updateData.removedSitePlans.length > 0) {
//       await Promise.all(
//         updateData.removedSitePlans.map((url) => {
//           const publicId = getPublicIdFromUrl(url);
//           if (publicId)
//             return cloudinary.uploader.destroy(
//               `customer/site_plans/${publicId}`
//             );
//         })
//       );

//       SitePlan = SitePlan.filter(
//         (img) => !updateData.removedSitePlans.includes(img)
//       );
//     }

//     // REMOVE ALL CUSTOMER IMAGES
//     if (
//       updateData.CustomerImage !== undefined &&
//       Array.isArray(updateData.CustomerImage) &&
//       updateData.CustomerImage.length === 0
//     ) {
//       await Promise.all(
//         CustomerImage.map((url) => {
//           const publicId = getPublicIdFromUrl(url);
//           if (publicId)
//             return cloudinary.uploader.destroy(
//               `customer/customer_images/${publicId}`
//             );
//         })
//       );
//       CustomerImage = [];
//     }

//     // REMOVE ALL SITE PLANS
//     if (
//       updateData.SitePlan !== undefined &&
//       Array.isArray(updateData.SitePlan) &&
//       updateData.SitePlan.length === 0
//     ) {
//       await Promise.all(
//         SitePlan.map((url) => {
//           const publicId = getPublicIdFromUrl(url);
//           if (publicId)
//             return cloudinary.uploader.destroy(
//               `customer/site_plans/${publicId}`
//             );
//         })
//       );
//       SitePlan = [];
//     }

//     // UPLOAD NEW CUSTOMER IMAGES
//     if (req.files?.CustomerImage) {
//       const uploads = req.files.CustomerImage.map((file) =>
//         cloudinary.uploader
//           .upload(file.path, {
//             folder: "customer/customer_images",
//             transformation: [{ width: 1000, crop: "limit" }],
//           })
//           .then((upload) => {
//             fs.unlinkSync(file.path);
//             return upload.secure_url;
//           })
//       );

//       CustomerImage.push(...(await Promise.all(uploads)));
//     }

//     // UPLOAD NEW SITE PLANS
//     if (req.files?.SitePlan) {
//       const uploads = req.files.SitePlan.map((file) =>
//         cloudinary.uploader
//           .upload(file.path, {
//             folder: "customer/site_plans",
//             transformation: [{ width: 1000, crop: "limit" }],
//           })
//           .then((upload) => {
//             fs.unlinkSync(file.path);
//             return upload.secure_url;
//           })
//       );

//       SitePlan.push(...(await Promise.all(uploads)));
//     }

//     // SAVE FINAL IMAGE ARRAYS
//     updateData.CustomerImage = JSON.stringify(CustomerImage);
//     updateData.SitePlan = JSON.stringify(SitePlan);

//     // Fix null relations
//     if (updateData.AssignToId === "") updateData.AssignToId = null;
//     if (updateData.CreatedById === "") updateData.CreatedById = null;

//     // REMOVE NON-DB KEYS
//     delete updateData.removedCustomerImages;
//     delete updateData.removedSitePlans;
//     delete updateData["removedCustomerImages "];
//     delete updateData["removedSitePlans "];

//     // UPDATE CUSTOMER
//     const updated = await prisma.customer.update({
//       where: { id },
//       data: updateData,
//     });

//     res.status(200).json({
//       success: true,
//       message: "Customer updated successfully",
//       data: await transformCustomer(updated),
//     });
//   } catch (error) {
//     next(new ApiError(500, error.message));
//   }
// };

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

    // UPDATE CUSTOMER
    const updated = await prisma.customer.update({
      where: { id },
      data: updateData,
    });

    res.status(200).json({
      success: true,
      message: "Customer updated successfully",
      data: await transformCustomer(updated),
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
export const assignCustomer = async (req, res, next) => {
  try {
    const { customerIds = [], assignToId } = req.body;
    const admin = req.admin;

    if (!Array.isArray(customerIds) || customerIds.length === 0 || !assignToId)
      return next(
        new ApiError(400, "customerIds (array) and assignToId are required")
      );

    const assignToAdmin = await prisma.admin.findUnique({
      where: { id: assignToId },
    });
    if (!assignToAdmin) return next(new ApiError(404, "Admin/User not found"));

    const customers = await prisma.customer.findMany({
      where: { id: { in: customerIds } },
    });
    if (customers.length === 0)
      return next(new ApiError(404, "No valid customers found"));

    if (admin.role === "city_admin") {
      const invalid = customers.filter((c) => c.City !== admin.city);
      if (invalid.length > 0)
        return next(
          new ApiError(403, "You can only assign customers in your city")
        );
      if (assignToAdmin.city !== admin.city)
        return next(
          new ApiError(403, "You can only assign to users in your city")
        );
    } else if (admin.role === "user") {
      return next(
        new ApiError(403, "Users are not allowed to assign customers")
      );
    }

    await prisma.customer.updateMany({
      where: { id: { in: customerIds } },
      data: { AssignToId: assignToId },
    });

    const updated = await prisma.customer.findMany({
      where: { id: { in: customerIds } },
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

    if (admin.role === "city_admin")
      where.City = { contains: admin.city, mode: "insensitive" };
    else if (admin.role === "user") where.AssignToId = admin._id || admin.id;

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