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
  checkDuplicateContacts,
  getTodayCustomers,
  qualifyCustomer,
  startCall,
  getCallLogs,
  getCallReport,
  deleteCallLogById,
  getRecommendedCustomer,
  dataMining,
  getClosedDeals,
  closeDeal,
  reopenDeal,
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
customerRoutes.get("/today", getTodayCustomers);
customerRoutes.get("/getcalllogs",getCallLogs);
customerRoutes.get("/get-call-report",getCallReport);
customerRoutes.get("/data-mining", dataMining);
customerRoutes.get("/", getCustomer);


customerRoutes.post("/check-duplicates", checkDuplicateContacts);
customerRoutes.post("/qualification-agent", qualifyCustomer);
customerRoutes.post("/recommended-customers",getRecommendedCustomer);

customerRoutes.post("/agent-call", startCall);


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

//call log delete route 
customerRoutes.delete("/delete-calllog/:id", deleteCallLogById);

//deal closing routes
customerRoutes.get("/closed-deals", protectRoute, getClosedDeals);
customerRoutes.post("/close-deal/:id",protectRoute,closeDeal);
customerRoutes.post("/reopen-deal/:id",protectRoute,reopenDeal);

customerRoutes.get("/:id", getCustomerById);

export default customerRoutes;
