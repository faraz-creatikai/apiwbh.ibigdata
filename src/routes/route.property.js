import express from "express";


import upload from "../config/multer.js";
import { validate } from "../middlewares/validate.js";

import { isCityAdminOrAbove, protectRoute } from "../middlewares/auth.js";
import { uploadExcel } from "../middlewares/uploadExcel.js";

import { createPropertyValidator, updatePropertyValidator } from "../validators/propertyValidator.js";
import { createProperty, deleteAllPropertys, deleteProperty, getFavouritePropertys, getProperty, getPropertyById, updateProperty } from "../controllers/controller.property.js";

const propertyRoutes = express.Router();

// ✅ Protected Routes
propertyRoutes.use(protectRoute);

// 🧭 Base CRUD Routes
propertyRoutes.get("/", getProperty);
propertyRoutes.get("/:id", getPropertyById);

propertyRoutes.post(
  "/",
  upload.fields([
    { name: "PropertyImage", maxCount: 5 },
    { name: "AgentImage", maxCount: 5 },
  ]),
  validate(createPropertyValidator),
  createProperty
);

propertyRoutes.put(
  "/:id",
  upload.fields([
    { name: "PropertyImage", maxCount: 5 },
    { name: "AgentImage", maxCount: 5 },
  ]),
  validate(updatePropertyValidator),
  updateProperty
);


propertyRoutes.delete("/:id", deleteProperty);
propertyRoutes.delete("/", deleteAllPropertys);

propertyRoutes.get("/favourites/all", getFavouritePropertys);

// 🧩 1️⃣ New API → Read headers from uploaded Excel
/* propertyRoutes.post(
  "/import/headers",
  protectRoute,
  isCityAdminOrAbove,
  uploadExcel.single("file"),
  readPropertyHeaders
); */

// 🧩 2️⃣ Existing API → Import propertys (with optional fieldMapping)
/* propertyRoutes.post(
  "/import",
  protectRoute,
  isCityAdminOrAbove,
  uploadExcel.single("file"),
  importPropertys
); */

propertyRoutes.get("/no, checkPhoneExists");

export default propertyRoutes;
