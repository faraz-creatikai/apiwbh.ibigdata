import express from "express";
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  getCustomerById,
  updateCustomer,
  deleteAllCustomers,
  getFavouriteCustomers,
  assignCustomer,
  bulkAssignCityCustomers,
} from "../controllers/controller.customer.js";

import upload from "../config/multer.js";
import { validate } from "../middlewares/validate.js";
import {
  createCustomerValidator,
  updateCustomerValidator,
} from "../validators/customerValidator.js";
import { isCityAdminOrAbove, protectRoute } from "../middlewares/auth.js";
import { uploadExcel } from "../middlewares/uploadExcel.js";
import {
  importCustomers,
  readCustomerHeaders, // ✅ <-- Import new header reader
} from "../controllers/customerImportController.js";

const customerRoutes = express.Router();

// ✅ Protected Routes
customerRoutes.use(protectRoute);

// 🧭 Base CRUD Routes
customerRoutes.get("/", getCustomer);
customerRoutes.get("/:id", getCustomerById);

customerRoutes.post(
  "/",
  upload.fields([
    { name: "CustomerImage", maxCount: 5 },
    { name: "SitePlan", maxCount: 5 },
  ]),
  validate(createCustomerValidator),
  createCustomer
);

customerRoutes.put(
  "/:id",
  upload.fields([
    { name: "CustomerImage", maxCount: 5 },
    { name: "SitePlan", maxCount: 5 },
  ]),
  validate(updateCustomerValidator),
  updateCustomer
);

// Assign & Reassign APIs
customerRoutes.post("/assign", assignCustomer);
customerRoutes.post("/assign-all-city", bulkAssignCityCustomers);

customerRoutes.delete("/:id", deleteCustomer);
customerRoutes.delete("/", deleteAllCustomers);

customerRoutes.get("/favourites/all", getFavouriteCustomers);

// 🧩 1️⃣ New API → Read headers from uploaded Excel
customerRoutes.post(
  "/import/headers",
  protectRoute,
  isCityAdminOrAbove,
  uploadExcel.single("file"),
  readCustomerHeaders
);

// 🧩 2️⃣ Existing API → Import customers (with optional fieldMapping)
customerRoutes.post(
  "/import",
  protectRoute,
  isCityAdminOrAbove,
  uploadExcel.single("file"),
  importCustomers
);

customerRoutes.get("/no, checkPhoneExists");

export default customerRoutes;
