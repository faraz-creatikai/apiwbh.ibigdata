import xlsx from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../config/prismaClient.js"; // your Prisma client instance
import ApiError from "../utils/ApiError.js";
import { logActivity } from "../utils/activityLogger.js";
import { parseContactCell } from "../utils/phoneParser.js";

// ----------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auto key mapping
const keyMap = {
  "customer name": "customerName",
  fullname: "customerName",
  name: "customerName",

  contactnumber: "ContactNumber",
  phone: "ContactNumber",
  mobile: "ContactNumber",

  email: "Email",
  city: "City",
  location: "Location",
  sublocation: "SubLocation",
  area: "Area",
  address: "Adderess",
  facilities: "Facillities",
  description: "Description",
  referenceid: "ReferenceId",
  price: "Price",
  url: "URL",
};

// Normalize row keys
const normalizeKeys = (row, manual = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const lower = (key || "").toLowerCase().trim();
    const finalKey = manual[lower] || keyMap[lower] || key;
    out[finalKey] = value;
  }
  return out;
};

// -----------------------------
// Helper: trimming + safe checks
// -----------------------------
const safeTrim = (v) => {
  if (v === null || v === undefined) return "";
  return String(v).trim();
};

const friendlyError = (err) => {
  // Prisma errors are multi-line; the last non-empty line is the useful one
  const msg = String(err?.message || "Unknown error").trim().split("\n").filter(Boolean).pop() || "Unknown error";
  return msg.length > 300 ? msg.slice(0, 300) + "…" : msg;
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const toReportItem = (row, meta, status, reasons = [], warnings = []) => ({
  rowNumber: meta?.rowNumber ?? null,
  customerName: row.customerName || "",
  contactRaw: meta?.phone?.raw ?? "",
  contactNumber: row.ContactNumber || "",
  countryCode: row.ContactNumber ? row.CountryCode : "",
  noContact: !!meta?.phone?.noContact, // contact was the 1010101010 placeholder
  status, // imported | duplicate | skipped | failed
  reasons,
  warnings,
});

// One flat row for the Excel summary sheets
const toSheetRow = (item) => ({
  Row: item.rowNumber ?? "",
  Name: item.customerName,
  "Contact in file": item.contactRaw,
  "Saved as": item.contactNumber ? `+${item.countryCode} ${item.contactNumber}` : "",
  "No contact number": item.noContact ? "Yes" : "",
  Status: item.status,
  Reason: item.reasons.join("; "),
  Notes: item.warnings.join("; "),
  "Customer ID": item.id ?? "",
});

const excelDateToString = (value) => {
  if (!value) return null;

  // ✅ Case 1: Already a JS Date (most common)
  if (value instanceof Date) {
    const day = String(value.getDate()).padStart(2, "0");
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const year = value.getFullYear();
    return `${day}-${month}-${year}`;
  }

  // ✅ Case 2: Excel numeric date
  if (typeof value === "number") {
    const jsDate = new Date(Math.round((value - 25569) * 86400 * 1000));
    const day = String(jsDate.getDate()).padStart(2, "0");
    const month = String(jsDate.getMonth() + 1).padStart(2, "0");
    const year = jsDate.getFullYear();
    return `${day}-${month}-${year}`;
  }

  // ✅ Case 3: String date (already dd-mm-yyyy)
  if (typeof value === "string") {
    return value.trim();
  }

  return null;
};

// ------------------------------------------------------
// IMPORT CONTROLLER (with auto-create master records)
// ------------------------------------------------------
export const importCustomers = async (req, res, next) => {
  // delete the uploaded temp file (safe to call more than once)
  const removeUpload = () => {
    if (req.file?.path) fs.unlink(req.file.path, () => { });
  };

  try {
    const admin = req.admin;

    if (!req.body.fieldMapping) {
      removeUpload();
      return next(new ApiError(400, "fieldMapping is required"));
    }

    // ----------------------------
    // Parse Manual Mapping
    // ----------------------------
    let manualMap = {};
    try {
      const parsed = JSON.parse(req.body.fieldMapping);
      Object.keys(parsed).forEach((key) => {
        manualMap[key.toLowerCase()] = parsed[key];
      });
    } catch {
      removeUpload();
      return next(new ApiError(400, "Invalid fieldMapping JSON"));
    }

    // ----------------------------
    // File check
    // ----------------------------
    if (!req.file) return next(new ApiError(400, "No file uploaded"));

    const workbook = xlsx.readFile(req.file.path, {
      cellDates: true,
    });
    const sheetName = workbook.SheetNames[0];
    const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
      raw: false,
      dateNF: "dd-mm-yyyy",
    });

    if (!sheet.length) {
      removeUpload();
      return next(new ApiError(400, "Empty Excel file"));
    }

    // Excel row number (header = row 1). __rowNum__ is 0-based and survives blank-row skipping.
    const rowNumbers = sheet.map((r, i) => (r.__rowNum__ ?? i + 1) + 1);

    // ----------------------------
    // Normalize all rows
    // ----------------------------
    const normalized = sheet.map((row) => normalizeKeys(row, manualMap));

    const activeFields = await prisma.customerFields.findMany({
      where: { Status: "Active" },
      select: { Name: true },
    });

    const allowedCustomerFieldKeys = new Set(
      activeFields.map((f) => f.Name.toLowerCase())
    );

    const rowMeta = new WeakMap(); // row object -> { rowNumber, phone }   (kept OUT of the row so Prisma never sees it)

    // ----------------------------
    // Process rows
    // ----------------------------
    const processed = normalized.map((r, idx) => {
      const phone = parseContactCell(r.ContactNumber);
      const countryCode = phone.countryCode;
      const firstPhone = phone.number; // "" when invalid -> row goes to skipped

      const email = safeTrim(r.Email) || null;

      const customerFields = {};

      const prismaCustomerKeys = new Set([
        "campaign",
        "customertype",
        "customersubtype",
        "customername",
        "contactnumber",
        "city",
        "location",
        "sublocation",
        "area",
        "adderess",
        "email",
        "facillities",
        "description",
        "customerdate",
        "price",
        "url",
        "other",
        "referenceid",
        "customerid",
        "customeryear",
        "video",
        "verified",
        "googlemap"
      ]);

      for (const key in r) {
        const lowerKey = key.toLowerCase();

        // ✅ Only store as CustomerField if it's in allowed (active) fields
        if (allowedCustomerFieldKeys.has(lowerKey)) {
          customerFields[key] = safeTrim(r[key]);
          delete r[key]; // remove from main object
        }

        // ❌ Otherwise, just delete unknown keys from payload
        else if (!prismaCustomerKeys.has(lowerKey)) {
          delete r[key]; // skip/store nothing
        }
      }

      let PriceNumber = 0;
      if (r.Price) {
        const raw = r.Price.toString().toLowerCase();

        let multiplier = 1;
        if (raw.includes("thousand") || raw.includes("thousands") || raw.includes("हज़ार")) {
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

        // unparseable prices (e.g. "1.5.2", "call us") would give NaN and make Prisma reject the row
        if (!Number.isFinite(PriceNumber)) PriceNumber = 0;
      }

      const out = {
        ...r,
        CustomerFields: customerFields,
        customerName: safeTrim(r.customerName || r.CustomerName || "") || "",
        ContactNumber: firstPhone,
        CountryCode: countryCode,
        Email: email,
        City: safeTrim(r.City) || "",
        Location: safeTrim(r.Location) || "",
        SubLocation: safeTrim(r.SubLocation) || "",
        Area: safeTrim(r.Area) || "",
        Adderess: safeTrim(r.Adderess) || "",
        Facillities: safeTrim(r.Facillities) || "",
        Description: safeTrim(r.Description) || "",
        Campaign: safeTrim(r.Campaign) || "",
        CustomerType: safeTrim(r.CustomerType) || "",
        CustomerSubType: safeTrim(r.CustomerSubType) || "",
        CustomerDate: excelDateToString(r.CustomerDate),
        Price: safeTrim(r.Price) || "",
        PriceNumber: PriceNumber,
        URL: safeTrim(r.URL) || "",
        Other: safeTrim(r.Other) || "",
        ReferenceId: safeTrim(r.ReferenceId) || ""
      };

      rowMeta.set(out, { rowNumber: rowNumbers[idx], phone });
      return out;
    });

    // --------------------------------------------------
    // Remove rows missing name or phone
    // (1010101010 counts as a phone: it is the "no contact number" placeholder)
    // --------------------------------------------------
    const valid = processed.filter((r) => r.customerName && r.ContactNumber);
    const invalidRows = processed.filter((r) => !r.customerName || !r.ContactNumber);

    const skippedItems = invalidRows.map((r) => {
      const meta = rowMeta.get(r);
      const reasons = [];
      if (!r.customerName) reasons.push("Customer name is missing");
      if (!r.ContactNumber) reasons.push(meta.phone.reason || "Contact number is invalid");
      return toReportItem(r, meta, "skipped", reasons);
    });

    const buildReport = ({ importedItems, duplicateItems, failedItems }) => {
      const noContactItems = importedItems.filter((i) => i.noContact);

      const reasonBreakdown = {};
      [...skippedItems, ...failedItems].forEach((i) =>
        i.reasons.forEach((rs) => (reasonBreakdown[rs] = (reasonBreakdown[rs] || 0) + 1))
      );

      const countryBreakdown = {};
      importedItems.forEach((i) => {
        countryBreakdown[i.countryCode] = (countryBreakdown[i.countryCode] || 0) + 1;
      });

      return {
        totalRows: processed.length,
        counts: {
          imported: importedItems.length,
          duplicates: duplicateItems.length, // these are ALSO inserted (existing behaviour)
          noContact: noContactItems.length, // these are ALSO inserted (1010101010 placeholder)
          skipped: skippedItems.length,
          failed: failedItems.length,
        },
        reasonBreakdown,
        countryBreakdown,
        rows: {
          imported: importedItems.slice(0, 200), // full list is in the Excel summary
          importedTruncated: importedItems.length > 200,
          duplicates: duplicateItems,
          noContact: noContactItems,
          skipped: skippedItems,
          failed: failedItems,
        },
        generatedAt: new Date().toISOString(),
      };
    };

    if (!valid.length) {
      removeUpload();
      return res.status(400).json({
        success: false,
        message: `No valid data. ${skippedItems.length} rows were skipped.`,
        report: buildReport({ importedItems: [], duplicateItems: [], failedItems: [] }),
      });
    }

    // ----------------------------
    // Duplicate check (CONTACT NUMBER)
    // ----------------------------
    // collect unique contact numbers from incoming rows
    const contactNumbers = [...new Set(valid.map((v) => v.ContactNumber))];

    // find all existing customers with same contact numbers (in chunks so big files don't hit query limits)
    const existingPhones = new Set();
    for (const part of chunk(contactNumbers, 1000)) {
      const existingByPhone = await prisma.customer.findMany({
        where: { ContactNumber: { in: part } },
        select: { ContactNumber: true },
      });
      existingByPhone.forEach((e) => e.ContactNumber && existingPhones.add(e.ContactNumber));
    }

    const importedItems = [];
    const duplicateItems = [];
    const failedItems = [];
    const dbPhones = new Set(existingPhones); // phones that existed BEFORE this file

    // ---------------------------------------------
    // CACHES to avoid repeated DB calls during import
    // key -> id (or boolean)
    // ---------------------------------------------
    const campaignCache = new Map(); // campaignName -> id
    const typeCache = new Map(); // `${campaignName}::${typeName}` -> id
    const subTypeCache = new Map(); // `${campaignName}::${typeName}::${subTypeName}` -> id
    const cityCache = new Map(); // cityName -> id
    const locationCache = new Map(); // `${cityName}::${locationName}` -> id
    const subLocationCache = new Map(); // `${cityName}::${locationName}::${subLocationName}` -> id
    const referenceIdCache = new Map();
    const leadTypeCache = new Map();

    // ---------------------------
    // Helper: Get or create Campaign
    // ---------------------------
    const getOrCreateCampaign = async (name) => {
      name = safeTrim(name);
      if (!name) return null;
      if (campaignCache.has(name)) return campaignCache.get(name);

      // Campaign.Name is unique in schema -> use findUnique
      const found = await prisma.campaign.findUnique({
        where: { Name: name },
        select: { id: true, Name: true },
      });

      if (found) {
        campaignCache.set(name, found.id);
        return found.id;
      }

      const created = await prisma.campaign.create({
        data: { Name: name },
      });

      campaignCache.set(name, created.id);
      return created.id;
    };

    // ---------------------------
    // Helper: Get or create Type (CustomerType) under campaign
    // ---------------------------
    const getOrCreateType = async (typeName, campaignName) => {
      typeName = safeTrim(typeName);
      campaignName = safeTrim(campaignName);
      if (!typeName) return null;

      const key = `${campaignName}::${typeName}`;
      if (typeCache.has(key)) return typeCache.get(key);

      // find campaignId first (if campaignName provided)
      let campaignId = null;
      if (campaignName) {
        campaignId = await getOrCreateCampaign(campaignName);
      }

      // Prisma has no compound unique for Type(Name, campaignId) -> use findFirst
      const found = await prisma.type.findFirst({
        where: campaignId ? { Name: typeName, campaignId } : { Name: typeName },
        select: { id: true },
      });

      if (found) {
        typeCache.set(key, found.id);
        return found.id;
      }

      // Schema: Type.campaignId is non-null. If user provided a typeName but no campaignName,
      // create/use a generic campaign named "Default".
      if (!campaignId) {
        campaignId = await getOrCreateCampaign("Default");
      }

      const created = await prisma.type.create({
        data: {
          Name: typeName,
          campaignId,
        },
      });

      typeCache.set(key, created.id);
      return created.id;
    };

    // ---------------------------
    // Helper: Get or create SubType under campaign and type
    // ---------------------------
    const getOrCreateSubType = async (subTypeName, campaignName, typeName) => {
      subTypeName = safeTrim(subTypeName);
      if (!subTypeName) return null;
      campaignName = safeTrim(campaignName);
      typeName = safeTrim(typeName);

      const key = `${campaignName}::${typeName}::${subTypeName}`;
      if (subTypeCache.has(key)) return subTypeCache.get(key);

      // Ensure campaign and type exist (and get their ids)
      const campaignId = campaignName
        ? await getOrCreateCampaign(campaignName)
        : await getOrCreateCampaign("Default");
      const typeId = await getOrCreateType(
        typeName || "Default",
        campaignName || "Default"
      );

      // Try findFirst
      const found = await prisma.subType.findFirst({
        where: { Name: subTypeName, campaignId, customerTypeId: typeId },
        select: { id: true },
      });

      if (found) {
        subTypeCache.set(key, found.id);
        return found.id;
      }

      const created = await prisma.subType.create({
        data: {
          Name: subTypeName,
          campaignId,
          customerTypeId: typeId,
        },
      });

      subTypeCache.set(key, created.id);
      return created.id;
    };

    // ---------------------------
    // Helper: Get or create City
    // ---------------------------
    const getOrCreateCity = async (name) => {
      name = safeTrim(name);
      if (!name) return null;
      if (cityCache.has(name)) return cityCache.get(name);

      const found = await prisma.city.findFirst({
        where: { Name: name },
        select: { id: true },
      });

      if (found) {
        cityCache.set(name, found.id);
        return found.id;
      }

      const created = await prisma.city.create({
        data: {
          Name: name,
          Status: "Active",
        },
      });

      cityCache.set(name, created.id);
      return created.id;
    };

    // ---------------------------
    // Helper: Get or create Location under city
    // ---------------------------
    const getOrCreateLocation = async (locationName, cityName) => {
      locationName = safeTrim(locationName);
      cityName = safeTrim(cityName);
      if (!locationName) return null;

      const key = `${cityName}::${locationName}`;
      if (locationCache.has(key)) return locationCache.get(key);

      // Ensure city exists
      const cityId = cityName ? await getOrCreateCity(cityName) : null;

      // If cityId is required by schema (Location.cityId is non-null), ensure we have one
      const effectiveCityId = cityId || (await getOrCreateCity("Default"));

      const found = await prisma.location.findFirst({
        where: { Name: locationName, cityId: effectiveCityId },
        select: { id: true },
      });

      if (found) {
        locationCache.set(key, found.id);
        return found.id;
      }

      const created = await prisma.location.create({
        data: {
          Name: locationName,
          cityId: effectiveCityId,
        },
      });

      locationCache.set(key, created.id);
      return created.id;
    };

    const getOrCreateSubLocation = async (subLocationName, locationName, cityName) => {
      subLocationName = safeTrim(subLocationName);
      locationName = safeTrim(locationName);
      cityName = safeTrim(cityName);
      if (!subLocationName) return null;

      const key = `${cityName}::${locationName}::${subLocationName}`;
      if (subLocationCache.has(key)) return subLocationCache.get(key);

      // Ensure city exists
      const cityId = cityName ? await getOrCreateCity(cityName) : await getOrCreateCity("Default");

      // Ensure location exists
      const locationId = locationName ? await getOrCreateLocation(locationName, cityName) : await getOrCreateLocation("Default", cityName || "Default");

      // Check if SubLocation already exists
      const found = await prisma.subLocation.findFirst({
        where: { Name: subLocationName, locationId },
        select: { id: true },
      });

      if (found) {
        subLocationCache.set(key, found.id);
        return found.id;
      }

      // Create SubLocation with both locationId and cityId
      const created = await prisma.subLocation.create({
        data: {
          Name: subLocationName,
          locationId,
          cityId,
        },
      });

      subLocationCache.set(key, created.id);
      return created.id;
    };

    const getOrCreateReferenceId = async (ref) => {
      ref = safeTrim(ref);
      if (!ref) return null;

      // cache by name
      if (referenceIdCache.has(ref)) return ref;

      // Name is NOT unique → use findFirst
      const found = await prisma.reference.findFirst({
        where: { Name: ref },
        select: { id: true },
      });

      if (found) {
        referenceIdCache.set(ref, true);
        return ref;
      }

      // create new reference
      await prisma.reference.create({
        data: {
          Name: ref,
          Status: "Active", // ✅ REQUIRED
        },
      });

      referenceIdCache.set(ref, true);
      return ref;
    };

    const getOrCreateLeadType = async (leadtypename) => {
      leadtypename = safeTrim(leadtypename);
      if (!leadtypename) return null;

      // cache by name
      if (leadTypeCache.has(leadtypename)) return leadtypename;

      // Name is NOT unique → use findFirst
      const found = await prisma.leadType.findFirst({
        where: { Name: leadtypename },
        select: { id: true },
      });

      if (found) {
        leadTypeCache.set(leadtypename, true);
        return leadtypename;
      }

      // create new lead type
      await prisma.leadType.create({
        data: {
          Name: leadtypename,
          Status: "Active", // ✅ REQUIRED
        },
      });

      leadTypeCache.set(leadtypename, true);
      return leadtypename;
    };

    // --------------------------------------------------
    // Insert one by one (safer) with master creation
    // --------------------------------------------------
    for (const row of valid) {
      const meta = rowMeta.get(row);

      // 1010101010 = "no contact number" placeholder. Many leads can share it,
      // so it must never be treated as a duplicate (or be added to the duplicate set).
      const isNoContact = !!meta?.phone?.noContact;
      const isDuplicate =
        !isNoContact && row.ContactNumber && existingPhones.has(row.ContactNumber);
      const warnings = [...(meta?.phone?.warnings || [])];

      if (isDuplicate) {
        warnings.push(
          dbPhones.has(row.ContactNumber)
            ? "Phone number already exists in the system (imported anyway)"
            : "Phone number is repeated earlier in this file (imported anyway)"
        );
      }

      try {
        // Auto-create master records (but we only store strings on customer)
        // We'll create master entries if provided in row (non-empty)
        if (row.Campaign) {
          await getOrCreateCampaign(row.Campaign);
        }
        if (row.CustomerType) {
          await getOrCreateType(row.CustomerType, row.Campaign || "Default");
        }
        if (row.CustomerSubType) {
          await getOrCreateSubType(
            row.CustomerSubType,
            row.Campaign || "Default",
            row.CustomerType || "Default"
          );
        }
        if (row.City) {
          await getOrCreateCity(row.City);
        }
        if (row.Location) {
          await getOrCreateLocation(row.Location, row.City || "Default");
        }
        if (row.SubLocation) {
          await getOrCreateSubLocation(row.SubLocation, row.Location || "Default", row.City || "Default");
        }

        if (row.ReferenceId) {
          await getOrCreateReferenceId(row.ReferenceId);
        }

        if (row.leadType) {
          await getOrCreateLeadType(row.LeadType);
        }

        // Create customer (Customer stores strings as before)
        const created = await prisma.customer.create({
          data: {
            ...row,
            CustomerFields: row.CustomerFields,
            CreatedById: admin.id,
            City: row.City || admin.city || "",
            isImported: true,
            updatedAt: new Date(),
          },
        });

        // the customer is saved from here on - nothing below may mark the row as failed
        const item = toReportItem(row, meta, isDuplicate ? "duplicate" : "imported", [], warnings);
        item.id = created.id;
        importedItems.push(item);
        if (isDuplicate) duplicateItems.push(item);

        if (row.ContactNumber && !isNoContact) existingPhones.add(row.ContactNumber);

        // ACTIVITY LOG TRIGGER (never lets a logging problem affect the import)
        try {
          Promise.resolve(
            logActivity({
              req,
              admin,
              action: "import", // Uses the new enum value
              entity: "customer",
              entityId: created.id,
              entityName: created.customerName,
              customerId: created.id,
              meta: {
                method: "excel_bulk_import",
                campaign: created.Campaign,
                city: created.City
              },
            })
          ).catch((e) => console.log("ACTIVITY LOG FAILED:", e?.message));
        } catch (e) {
          console.log("ACTIVITY LOG FAILED:", e?.message);
        }
      } catch (err) {
        console.log("IMPORT FAILED:", err);
        failedItems.push(toReportItem(row, meta, "failed", [friendlyError(err)], warnings));
      }
    }

    const report = buildReport({ importedItems, duplicateItems, failedItems });
    const noContactCount = report.counts.noContact;

    // --------------------------------------------------
    // Create Excel Summary
    // (a problem here must not hide the report - customers are already saved)
    // --------------------------------------------------
    let summaryUrl;
    try {
      const summaryDir = path.join(__dirname, "../uploads/summaries");
      if (!fs.existsSync(summaryDir))
        fs.mkdirSync(summaryDir, { recursive: true });

      const filePath = path.join(summaryDir, `summary-${Date.now()}.xlsx`);
      const wb = xlsx.utils.book_new();

      const addSheet = (name, items) =>
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(items.map(toSheetRow)), name);

      addSheet("Imported", importedItems);
      addSheet("No Contact", importedItems.filter((i) => i.noContact));
      addSheet("Duplicates", duplicateItems);
      addSheet("Invalid", skippedItems);
      addSheet("Failed", failedItems);

      xlsx.writeFile(wb, filePath);
      summaryUrl = `/uploads/summaries/${path.basename(filePath)}`;
    } catch (e) {
      console.log("SUMMARY FILE FAILED:", e);
    }

    // cleanup
    removeUpload();

    return res.status(200).json({
      success: true,
      message:
        `${importedItems.length} imported` +
        ` (${duplicateItems.length} duplicates, ${noContactCount} without contact number)` +
        `, ${skippedItems.length} skipped, ${failedItems.length} failed.`,
      imported: importedItems.length,
      duplicates: duplicateItems.length,
      noContact: noContactCount,
      invalid: skippedItems.length,
      failed: failedItems.length,
      file: summaryUrl,
      report,
    });
  } catch (err) {
    removeUpload();
    next(new ApiError(500, err.message));
  }
};

// ------------------------------
// Read Excel Headers
// ------------------------------
export const readCustomerHeaders = async (req, res, next) => {
  try {
    if (!req.file) return next(new ApiError(400, "No file uploaded"));

    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    fs.unlink(req.file.path, () => { });

    const headers = data[0] || [];
    if (!headers.length)
      return next(new ApiError(400, "No headers found in file"));

    res.status(200).json({
      success: true,
      message: "Headers extracted successfully",
      headers,
    });
  } catch (error) {
    if (req.file?.path) fs.unlink(req.file.path, () => { });
    next(new ApiError(500, error.message));
  }
};