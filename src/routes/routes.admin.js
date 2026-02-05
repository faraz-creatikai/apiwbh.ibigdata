import express from "express";
import {
  adminLogin,
  adminLogout,
  adminSignup,
  checkAuth,
  createAdmin,
  updateAdminDetails,
  updatePassword,
  getAllAdmins,
  getAdminById,
  deleteAdmin,
} from "../controllers/controller.admin.js";
import { validate } from "../middlewares/validate.js";
import {
  adminValidator,
  createAdminValidator,
  updateAdminValidator,
  updatePasswordValidator,
} from "../validators/adminValidator.js";
import {
  protectRoute,
  isAdministrator,
  isCityAdminOrAbove,
} from "../middlewares/auth.js";

const adminRoutes = express.Router();

// Public routes
adminRoutes.post("/signup", validate(adminValidator), adminSignup);
adminRoutes.post("/login", validate(adminValidator), adminLogin);

// Protected routes
adminRoutes.get("/check", protectRoute, checkAuth);
adminRoutes.post("/logout", protectRoute, adminLogout);

// Create new admin/user (City Admin or Administrator)
adminRoutes.post(
  "/create",
  protectRoute,
  isCityAdminOrAbove,
  validate(createAdminValidator),
  createAdmin
);

// Get all admins (City Admin or Administrator)
adminRoutes.get("/all", protectRoute, getAllAdmins);

// Get single admin by ID
adminRoutes.get("/:id", protectRoute, getAdminById);

// Update admin details
adminRoutes.put(
  "/:id/details",
  protectRoute,
  validate(updateAdminValidator),
  updateAdminDetails
);

// Update password
adminRoutes.put(
  "/:id/password",
  protectRoute,
  validate(updatePasswordValidator),
  updatePassword
);

// Delete admin (Administrator only)
adminRoutes.delete("/:id", protectRoute, isAdministrator, deleteAdmin);

export default adminRoutes;
