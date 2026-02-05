import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import ApiError from "../utils/ApiError.js";

const prisma = new PrismaClient();

// ------------------- PROTECT ROUTE -------------------
export const protectRoute = async (req, res, next) => {
  try {
    const token = req.headers.token || req.cookies.token;

    if (!token) {
      throw new ApiError(401, "Access denied. No token provided");
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Prisma equivalent of findById + select -password
    const admin = await prisma.admin.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        city: true,
        phone: true,
        status: true,
        AddressLine1: true,
        AddressLine2: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!admin) {
      throw new ApiError(404, "Admin not found");
    }

    if (admin.status === "inactive") {
      throw new ApiError(403, "Account has been deactivated");
    }

    req.admin = admin;
    next();
  } catch (error) {
    console.log(error.message);

    if (error instanceof ApiError) {
      return res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ success: false, message: "Invalid token" });
    }

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Token expired" });
    }

    return res.status(500).json({ success: false, message: error.message });
  }
};

// Check if user is administrator
export const isAdministrator = (req, res, next) => {
  try {
    if (req.admin.role !== "administrator") {
      throw new ApiError(
        403,
        "Access denied. Administrator privileges required"
      );
    }
    next();
  } catch (error) {
    if (error instanceof ApiError) {
      res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
    } else {
      res.status(500).json({ success: false, message: error.message });
    }
  }
};

// Check if user is city admin or administrator
export const isCityAdminOrAbove = (req, res, next) => {
  try {
    if (req.admin.role !== "administrator" && req.admin.role !== "city_admin") {
      throw new ApiError(
        403,
        "Access denied. City Admin or Administrator privileges required"
      );
    }
    next();
  } catch (error) {
    if (error instanceof ApiError) {
      res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
    } else {
      res.status(500).json({ success: false, message: error.message });
    }
  }
};

// Check if user can manage specific admin

export const canManageAdmin = async (req, res, next) => {
  try {
    const targetAdminId = req.params.id || req.body.adminId;

    if (!targetAdminId) {
      throw new ApiError(400, "Admin ID is required");
    }

    const targetAdmin = await prisma.admin.findUnique({
      where: { id: targetAdminId },
    });

    if (!targetAdmin) {
      throw new ApiError(404, "Target admin not found");
    }

    const currentAdmin = req.admin;

    // Administrator can manage everyone
    if (currentAdmin.role === "administrator") {
      req.targetAdmin = targetAdmin;
      return next();
    }

    // City Admin can manage users in their city
    if (currentAdmin.role === "city_admin") {
      if (
        targetAdmin.role === "user" &&
        targetAdmin.city === currentAdmin.city
      ) {
        req.targetAdmin = targetAdmin;
        return next();
      }

      throw new ApiError(403, "You can only manage users in your city");
    }

    // Users can manage only themselves
    if (currentAdmin.role === "user") {
      if (currentAdmin.id === targetAdmin.id) {
        req.targetAdmin = targetAdmin;
        return next();
      }

      throw new ApiError(403, "You can only manage your own account");
    }

    throw new ApiError(403, "Access denied");
  } catch (error) {
    if (error instanceof ApiError) {
      return res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
    }

    return res.status(500).json({ success: false, message: error.message });
  }
};
