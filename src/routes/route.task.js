import express from "express";
import {
  createTask,
  deleteTask,
  getTask,
  getTaskById,
  updateTask,
} from "../controllers/controller.task.js";

import { validate } from "../middlewares/validate.js";
import {
  createTaskValidator,
  updateTaskValidator,
} from "../validators/taskvalidator.js";
import { isCityAdminOrAbove, protectRoute } from "../middlewares/auth.js";

const taskRoutes = express.Router();

taskRoutes.use(protectRoute);

taskRoutes.get("/", getTask);
taskRoutes.get("/:id", isCityAdminOrAbove, getTaskById);
taskRoutes.post(
  "/",
  validate(createTaskValidator),
  isCityAdminOrAbove,
  createTask
);
taskRoutes.put(
  "/:id",
  validate(updateTaskValidator),
  isCityAdminOrAbove,
  updateTask
);
taskRoutes.delete("/", isCityAdminOrAbove, deleteTask);

export default taskRoutes;
