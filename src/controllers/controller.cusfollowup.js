import { PrismaClient } from "@prisma/client";

import ApiError from "../utils/ApiError.js";

const prisma = new PrismaClient();

// ---------------------------------------------------
//  HELPER FUNCTION (TRANSFORM FOLLOWUP TO DESIRED FORMAT)
// ---------------------------------------------------
const transformFollowup = (followup) => ({
  _id: followup.id,
  customer: {
    _id: followup.customer?.id,
    Campaign: followup.customer?.Campaign || "",
    CustomerType: followup.customer?.CustomerType || "",
    CustomerSubType: followup.customer?.CustomerSubType || "",
    customerName: followup.customer?.customerName || "",
    ContactNumber: followup.customer?.ContactNumber || "",
    Email: followup.customer?.Email || "",
    City: followup.customer?.City || "",
    Location: followup.customer?.Location || "",
    Area: followup.customer?.Area || "",
    Adderess: followup.customer?.Adderess || "",
    Facillities: followup.customer?.Facillities || "",
    ReferenceId: followup.customer?.ReferenceId || "",
    CustomerId: followup.customer?.CustomerId || "",
    CustomerDate: followup.customer?.CustomerDate || "",
    CustomerYear: followup.customer?.CustomerYear || "",
    Other: followup.customer?.Other || "",
    Description: followup.customer?.Description || "",
    Video: followup.customer?.Video || "",
    Verified: followup.customer?.Verified || "",
    GoogleMap: followup.customer?.GoogleMap || "",
    CustomerImage: followup.customer?.CustomerImage || [],
    SitePlan: followup.customer?.SitePlan || [],
    isFavourite: followup.customer?.isFavourite || false,
    AssignTo: followup.customer?.AssignTo
      ? {
        _id: followup.customer.AssignTo.id,
        name: followup.customer.AssignTo.name,
        email: followup.customer.AssignTo.email,
        role: followup.customer.AssignTo.role,
        city: followup.customer.AssignTo.city,
        status: followup.customer.AssignTo.status,
      }
      : null,
    CreatedBy: followup.customer?.CreatedBy || null,
    isImported: followup.customer?.isImported || false,
    __v: followup.customer?.__v || 0,
    createdAt: followup.customer?.createdAt,
    updatedAt: followup.customer?.updatedAt,
  },
  StartDate: followup.StartDate || "",
  StatusType: followup.StatusType || "",
  FollowupNextDate: followup.FollowupNextDate || "",
  Description: followup.Description || "",
  createdAt: followup.createdAt,
  updatedAt: followup.updatedAt,

  // Flattened customer fields
  Campaign: followup.customer?.Campaign || "",
  CustomerType: followup.customer?.CustomerType || "",
  CustomerSubType: followup.customer?.CustomerSubType || "",
  City: followup.customer?.City || "",
  Location: followup.customer?.Location || "",
  ReferenceId: followup.customer?.ReferenceId || "",
  customerName: followup.customer?.customerName || "",
  ContactNumber: followup.customer?.ContactNumber || "",
  AssignTo: followup.customer?.AssignTo
    ? {
      _id: followup.customer.AssignTo.id,
      name: followup.customer.AssignTo.name,
      email: followup.customer.AssignTo.email,
      role: followup.customer.AssignTo.role,
      city: followup.customer.AssignTo.city,
      status: followup.customer.AssignTo.status,
    }
    : null,
});

// ---------------------------------------------------
//  CREATE FOLLOWUP
// ---------------------------------------------------
export const createFollowup = async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const { StartDate, StatusType, FollowupNextDate, Description } = req.body;

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) return next(new ApiError(404, "Customer not found"));

    const followup = await prisma.followup.create({
      data: {
        customerId,
        StartDate,
        StatusType,
        FollowupNextDate,
        Description,
      },
      include: { customer: { include: { AssignTo: true } } },
    });

    res.status(201).json({
      success: true,
      message: "Follow-up created successfully",
      data: transformFollowup(followup),
    });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// ---------------------------------------------------
//  GET ALL FOLLOWUPS (FILTERS + PAGINATION)
// ---------------------------------------------------
export const getFollowups = async (req, res, next) => {
  try {
    const admin = req.admin;

    const {
      page = 1,
      limit = 10,
      keyword = "",
      StatusType,
      Campaign,
      CustomerSubType,
      PropertyType,
      City,
      Location,
      User,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const perPage = Math.max(1, parseInt(limit));
    const skip = (pageNum - 1) * perPage;

    // -------------------------
    // FOLLOWUP FILTER
    // -------------------------
    const whereFollowup = {};
    if (StatusType) whereFollowup.StatusType = StatusType.trim();

    // -------------------------
    // CUSTOMER FILTER (inside followup)
    // -------------------------
    const customerFilter = {};

    // Query filters
    if (Campaign) customerFilter.Campaign = { contains: Campaign.trim() };
    if (PropertyType)
      customerFilter.CustomerType = { contains: PropertyType.trim() };
    if (CustomerSubType)
      customerFilter.CustomerSubType = { contains: CustomerSubType.trim() };
    if (City) customerFilter.City = { contains: City.trim() };
    if (Location) customerFilter.Location = { contains: Location.trim() };

    // Filter by AssignTo name
    if (User) {
      customerFilter.AssignTo = {
        name: { contains: User.trim() },
      };
    }
    if (admin.role === "user") {
      customerFilter.AssignTo = { id: admin.id }; // <── FIX
    }

    // Keyword filter
    if (keyword) {
      const kw = keyword.trim();
      customerFilter.OR = [
        { customerName: { contains: kw } },
        { ContactNumber: { contains: kw } },
        { Email: { contains: kw } },
        { City: { contains: kw } },
        { Location: { contains: kw } },
      ];
    }

    // -------------------------
    // FETCH FOLLOWUPS WITH CUSTOMER FILTERS
    // -------------------------
    const [total, followups] = await Promise.all([
      prisma.followup.count({
        where: {
          ...whereFollowup,
          customer: Object.keys(customerFilter).length
            ? customerFilter
            : undefined,
        },
      }),
      prisma.followup.findMany({
        where: {
          ...whereFollowup,
          customer: Object.keys(customerFilter).length
            ? customerFilter
            : undefined,
        },
        include: { customer: { include: { AssignTo: true } } },
        skip,
        take: perPage,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // -------------------------
    // RESPONSE
    // -------------------------
    res.status(200).json({
      success: true,
      total,
      currentPage: pageNum,
      totalPages: Math.ceil(total / perPage),
      data: followups.map(transformFollowup),
    });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// ---------------------------------------------------
//  GET FOLLOWUPS BY CUSTOMER
// ---------------------------------------------------
export const getFollowupByCustomer = async (req, res, next) => {
  try {
    const { customerId } = req.params;

    const followups = await prisma.followup.findMany({
      where: { customerId },
      include: { customer: true }, // just to get customer.id
      orderBy: { createdAt: "desc" },
    });

    const transformed = followups.map((f) => ({
      _id: f.id,
      customer: f.customer.id, // flatten to just customer ID
      StartDate: f.StartDate,
      StatusType: f.StatusType,
      FollowupNextDate: f.FollowupNextDate,
      Description: f.Description,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      __v: 0, // to match MongoDB format
    }));

    res.status(200).json({
      success: true,
      total: transformed.length,
      data: transformed,
    });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// ---------------------------------------------------
//  GET FOLLOWUP BY ID
// ---------------------------------------------------
export const getFollowupById = async (req, res, next) => {
  try {
    const followup = await prisma.followup.findUnique({
      where: { id: req.params.id },
      include: { customer: true }, // only include customer to get its id
    });

    if (!followup) return next(new ApiError(404, "Follow-up not found"));

    // Transform the followup to match the desired response format
    const transformed = {
      _id: followup.id,
      customer: followup.customer.id, // only return customer ID
      StartDate: followup.StartDate,
      StatusType: followup.StatusType,
      FollowupNextDate: followup.FollowupNextDate,
      Description: followup.Description,
      createdAt: followup.createdAt,
      updatedAt: followup.updatedAt,
      __v: 0, // if you want to keep __v like MongoDB
    };

    res.status(200).json({ success: true, data: transformed });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// ---------------------------------------------------
//  UPDATE FOLLOWUP
// ---------------------------------------------------
export const updateFollowup = async (req, res, next) => {
  try {
    const { StartDate, StatusType, FollowupNextDate, Description } = req.body;

    const updatedFollowup = await prisma.followup.update({
      where: { id: req.params.id },
      data: {
        ...(StartDate && { StartDate }),
        ...(StatusType && { StatusType }),
        ...(FollowupNextDate && { FollowupNextDate }),
        ...(Description && { Description }),
      },
      include: { customer: { include: { AssignTo: true } } },
    });

    res.status(200).json({
      success: true,
      message: "Follow-up updated successfully",
      data: transformFollowup(updatedFollowup),
    });
  } catch (error) {
    if (error.code === "P2025")
      return next(new ApiError(404, "Follow-up not found"));
    next(new ApiError(500, error.message));
  }
};

// ---------------------------------------------------
//  DELETE FOLLOWUP
// ---------------------------------------------------
export const deleteFollowup = async (req, res, next) => {
  try {
    await prisma.followup.delete({ where: { id: req.params.id } });
    res
      .status(200)
      .json({ success: true, message: "Follow-up deleted successfully" });
  } catch (error) {
    if (error.code === "P2025")
      return next(new ApiError(404, "Follow-up not found"));
    next(new ApiError(500, error.message));
  }
};

// ---------------------------------------------------
//  DELETE FOLLOWUPS BY CUSTOMER
// ---------------------------------------------------
export const deleteFollowupsByCustomer = async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const result = await prisma.followup.deleteMany({ where: { customerId } });
    res.status(200).json({
      success: true,
      message: "All followups for this customer have been deleted",
      deletedCount: result.count,
    });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};
