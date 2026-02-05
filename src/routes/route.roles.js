import express from "express";
import {
  createRole,
  deleteRole,
  getRole,
  getRoleById,
  updateRole,
} from "../controllers/controller.roles.js";

import { validate } from "../middlewares/validate.js";
import {
  createRoleValidator,
  updateRoleValidator,
} from "../validators/rolevalidator.js";
import { isAdministrator, protectRoute } from "../middlewares/auth.js";

const roleRoutes = express.Router();

roleRoutes.use(protectRoute);

roleRoutes.get("/", getRole);
roleRoutes.get("/:id", isAdministrator, getRoleById);
roleRoutes.post(
  "/",
  isAdministrator,
  validate(createRoleValidator),
  createRole
);
roleRoutes.put(
  "/:id",
  isAdministrator,
  validate(updateRoleValidator),
  updateRole
);
roleRoutes.delete("/:id", isAdministrator, deleteRole);

export default roleRoutes;
