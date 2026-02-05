import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";

export const transformTask = (task) => ({
  _id: task.id,
  date: task.date,
  Time: task.Time,
  Description: task.Description,
  User: task.User,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

// ------------------------------------------------------------------
// ✅ GET ALL TASKS WITH FILTERS
// ------------------------------------------------------------------
export const getTask = async (req, res, next) => {
  try {
    const { User, keyword, limit } = req.query;

    let where = {};

    if (User) {
      where.User = { contains: User.trim(), mode: "insensitive" };
    }

    if (keyword) {
      where.Description = { contains: keyword, mode: "insensitive" };
    }

    const tasks = await prisma.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit ? Number(limit) : undefined,
    });

    res.status(200).json(tasks.map(transformTask));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// ------------------------------------------------------------------
// ✅ GET BY ID
// ------------------------------------------------------------------
export const getTaskById = async (req, res, next) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
    });

    if (!task) return next(new ApiError(404, "Task not found"));

    res.status(200).json(transformTask(task));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// ------------------------------------------------------------------
// ✅ CREATE TASK
// ------------------------------------------------------------------
export const createTask = async (req, res, next) => {
  try {
    const { date, Time, Description, User } = req.body;

    const newTask = await prisma.task.create({
      data: { date, Time, Description, User },
    });

    res.status(201).json(transformTask(newTask));
  } catch (error) {
    next(new ApiError(400, error.message));
  }
};

// ------------------------------------------------------------------
// ✅ UPDATE TASK
// ------------------------------------------------------------------
export const updateTask = async (req, res, next) => {
  try {
    // 🔥 Clone body safely
    let updateData = { ...req.body };

    // ❌ Remove fields Prisma cannot update
    delete updateData.id;
    delete updateData._id;
    delete updateData.createdAt;
    delete updateData.updatedAt;
    delete updateData.CreatedBy;

    const updatedTask = await prisma.task.update({
      where: { id: req.params.id },
      data: updateData, // <-- cleaned data
    });

    res.status(200).json(transformTask(updatedTask));
  } catch (error) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "Task not found"));
    }
    next(new ApiError(400, error.message));
  }
};

// ------------------------------------------------------------------
// ✅ DELETE: SELECTED OR ALL TASKS
// ------------------------------------------------------------------
export const deleteTask = async (req, res, next) => {
  try {
    const { taskIds } = req.body;

    // DELETE ALL
    if (!taskIds || taskIds.length === 0) {
      const all = await prisma.task.findMany();

      if (all.length === 0)
        return next(new ApiError(404, "No tasks found to delete"));

      await prisma.task.deleteMany();

      return res.status(200).json({
        success: true,
        message: "All tasks deleted successfully",
        deletedTaskIds: all.map((t) => t.id),
      });
    }

    // DELETE SELECTED
    await prisma.task.deleteMany({
      where: { id: { in: taskIds } },
    });

    res.status(200).json({
      success: true,
      message: "Selected tasks deleted successfully",
      deletedTaskIds: taskIds,
    });
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};
