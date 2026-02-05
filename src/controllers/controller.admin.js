import prisma from "../config/prismaClient.js";
import bcrypt from "bcryptjs";
import ApiError from "../utils/ApiError.js";
import { genrateToken } from "../config/adminjwt.js";
import { sendSystemEmail } from "../config/mailer.js";

// Helper to keep _id like MongoDB
const transform = (admin) => {
  if (!admin) return null;
  const obj = { _id: admin.id, ...admin };
  delete obj.id;
  delete obj.password;
  return obj;
};

// ---------------------------------------------
// SIGNUP (first administrator OR delegated creation)
// ---------------------------------------------
export const adminSignup = async (req, res) => {
  const { name, email, password, role, city, phone } = req.body;

  try {
    if (!email || !password || !name || !role) {
      throw new ApiError(400, "Missing required details");
    }

    const existingAdmin = await prisma.admin.findFirst({
      where: { role: "administrator" },
    });

    if (existingAdmin && role === "administrator") {
      throw new ApiError(
        403,
        "Administrator account already exists. Use create admin endpoint."
      );
    }

    const admin = await prisma.admin.findFirst({ where: { email } });
    if (admin) throw new ApiError(409, "Account already exists");

    if ((role === "city_admin" || role === "user") && !city) {
      throw new ApiError(400, "City is required for this role");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newAdmin = await prisma.admin.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role,
        city: city || null,
        phone,
      },
    });

    const token = genrateToken(newAdmin.id);

    res.status(201).json({
      success: true,
      adminData: transform(newAdmin),
      token,
      message: "Account created successfully",
    });
  } catch (error) {
    console.log(error.message);
    res
      .status(error instanceof ApiError ? error.statusCode : 500)
      .json({ success: false, message: error.message });
  }
};

// ---------------------------------------------
// CREATE ADMIN (administrator or city_admin)
// ---------------------------------------------
export const createAdmin = async (req, res) => {
  const {
    name,
    email,
    password,
    role,
    city,
    phone,
    AddressLine1,
    AddressLine2,
  } = req.body;

  try {
    const currentAdmin = req.admin;

    if (currentAdmin.role === "administrator") {
    } else if (currentAdmin.role === "city_admin") {
      if (role !== "user")
        throw new ApiError(403, "City admins can only create users");
      if (city !== currentAdmin.city)
        throw new ApiError(403, "You can only create users in your city");
    } else {
      throw new ApiError(403, "No permission to create accounts");
    }

    if (!email || !password || !name || !role)
      throw new ApiError(400, "Missing required details");

    const existingAdmin = await prisma.admin.findFirst({ where: { email } });
    if (existingAdmin) throw new ApiError(409, "Account already exists");

    if ((role === "city_admin" || role === "user") && !city)
      throw new ApiError(400, "City is required for this role");

    const hashedPassword = await bcrypt.hash(password, 10);

    const newAdmin = await prisma.admin.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role,
        city: city || null,
        phone,
        AddressLine1,
        AddressLine2,
        createdBy: currentAdmin.id,
      },
    });

    sendSystemEmail(email, name, password, role).catch(() => {});

    res.status(201).json({
      success: true,
      adminData: transform(newAdmin),
      message: `${role} created successfully. Login credentials have been sent via email.`,
    });
  } catch (error) {
    console.log(error.message);
    res
      .status(error instanceof ApiError ? error.statusCode : 500)
      .json({ success: false, message: error.message });
  }
};

// ---------------------------------------------
// LOGIN
// ---------------------------------------------
export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) throw new ApiError(400, "Missing login details");

    const adminData = await prisma.admin.findFirst({
      where: { email },
    });

    if (!adminData) throw new ApiError(404, "Admin not found");

    if (adminData.status === "inactive") {
      throw new ApiError(403, "Account has been deactivated");
    }

    const isPasswordCorrect = await bcrypt.compare(
      password,
      adminData.password
    );

    if (!isPasswordCorrect) throw new ApiError(401, "Invalid credentials");

    const token = genrateToken(adminData.id);

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      success: true,
      adminData: transform(adminData),
      token,
      message: "Login successful",
    });
  } catch (error) {
    console.log(error.message);
    res
      .status(error instanceof ApiError ? error.statusCode : 500)
      .json({ success: false, message: error.message });
  }
};

// ---------------------------------------------
// CHECK AUTH
// ---------------------------------------------
export const checkAuth = (req, res) => {
  res.json({ success: true, admin: transform(req.admin) });
};

// ---------------------------------------------
// LOGOUT
// ---------------------------------------------
export const adminLogout = async (req, res) => {
  try {
    res.clearCookie("token", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });

    res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.log(error.message);
    res
      .status(error instanceof ApiError ? error.statusCode : 500)
      .json({ success: false, message: error.message });
  }
};

// ---------------------------------------------
// UPDATE ADMIN DETAILS
// ---------------------------------------------
export const updateAdminDetails = async (req, res) => {
  try {
    const targetAdminId = req.params.id;
    const currentAdmin = req.admin;

    const targetAdmin = await prisma.admin.findUnique({
      where: { id: targetAdminId },
    });

    if (!targetAdmin) throw new ApiError(404, "Admin not found");

    // SAME PERMISSION LOGIC AS MONGO
    if (currentAdmin.role === "administrator") {
    } else if (currentAdmin.role === "city_admin") {
      if (
        targetAdmin.role !== "user" ||
        targetAdmin.city !== currentAdmin.city
      ) {
        throw new ApiError(403, "You can only update users in your city");
      }
    } else if (currentAdmin.role === "user") {
      if (targetAdmin.id !== currentAdmin.id) {
        throw new ApiError(403, "You can only update your own details");
      }
    }

    const updates = {};

    if (req.body.name) updates.name = req.body.name;
    if (req.body.AddressLine1) updates.AddressLine1 = req.body.AddressLine1;
    if (req.body.AddressLine2) updates.AddressLine2 = req.body.AddressLine2;

    if (req.body.email) {
      const emailExists = await prisma.admin.findFirst({
        where: {
          email: req.body.email,
          NOT: { id: targetAdminId },
        },
      });
      if (emailExists) throw new ApiError(409, "Email already in use");
      updates.email = req.body.email;
    }

    if (req.body.phone !== undefined) updates.phone = req.body.phone;

    if (req.body.city && currentAdmin.role === "administrator") {
      updates.city = req.body.city;
    }

    if (req.body.status && currentAdmin.role === "administrator") {
      if (!["Active", "Inactive"].includes(req.body.status)) {
        throw new ApiError(400, "Status must be either 'Active' or 'Inactive'");
      }
      updates.status = req.body.status;
    }

    const updated = await prisma.admin.update({
      where: { id: targetAdminId },
      data: updates,
    });

    res.json({
      success: true,
      adminData: transform(updated),
      message: "Details updated successfully",
    });
  } catch (error) {
    console.log(error.message);
    res
      .status(error instanceof ApiError ? error.statusCode : 500)
      .json({ success: false, message: error.message });
  }
};

// ---------------------------------------------
// UPDATE PASSWORD
// ---------------------------------------------
export const updatePassword = async (req, res) => {
  try {
    const targetAdminId = req.params.id;
    const { currentPassword, newPassword } = req.body;
    const currentAdmin = req.admin;

    if (!newPassword || newPassword.length < 6) {
      throw new ApiError(
        400,
        "New password must be at least 6 characters long"
      );
    }

    const targetAdmin = await prisma.admin.findUnique({
      where: { id: targetAdminId },
    });

    if (!targetAdmin) throw new ApiError(404, "Admin not found");

    // SAME PERMISSION RULES AS MONGO
    if (currentAdmin.role === "administrator") {
    } else if (currentAdmin.role === "city_admin") {
      if (
        targetAdmin.role !== "user" ||
        targetAdmin.city !== currentAdmin.city
      ) {
        throw new ApiError(
          403,
          "You can only update passwords of users in your city"
        );
      }

      if (targetAdmin.id === currentAdmin.id) {
        if (!currentPassword)
          throw new ApiError(400, "Current password is required");

        const match = await bcrypt.compare(
          currentPassword,
          targetAdmin.password
        );

        if (!match) throw new ApiError(401, "Current password is incorrect");
      }
    } else if (currentAdmin.role === "user") {
      if (targetAdmin.id !== currentAdmin.id) {
        throw new ApiError(403, "You can only update your own password");
      }

      if (!currentPassword)
        throw new ApiError(400, "Current password is required");

      const match = await bcrypt.compare(currentPassword, targetAdmin.password);

      if (!match) throw new ApiError(401, "Current password is incorrect");
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await prisma.admin.update({
      where: { id: targetAdminId },
      data: { password: hashed },
    });

    res.json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    console.log(error.message);
    res
      .status(error instanceof ApiError ? error.statusCode : 500)
      .json({ success: false, message: error.message });
  }
};

// ---------------------------------------------
// GET ALL ADMINS
// ---------------------------------------------
export const getAllAdmins = async (req, res) => {
  try {
    const currentAdmin = req.admin;
    const { role, city, status } = req.query;

    let where = {};

    if (currentAdmin.role === "administrator") {
      if (role) where.role = role;
      if (city) where.city = city;
      if (status) where.status = status;
    } else if (currentAdmin.role === "city_admin") {
      where.city = currentAdmin.city;
      where.role = "user";
    } else if (currentAdmin.role === "user") {
      where.id = currentAdmin.id;
    } else {
      throw new ApiError(403, "Access denied");
    }

    const admins = await prisma.admin.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    res.json({
      success: true,
      count: admins.length,
      admins: admins.map(transform),
    });
  } catch (error) {
    console.log(error.message);
    res
      .status(error instanceof ApiError ? error.statusCode : 500)
      .json({ success: false, message: error.message });
  }
};

// ---------------------------------------------
// GET ADMIN BY ID
// ---------------------------------------------
export const getAdminById = async (req, res) => {
  try {
    const targetAdminId = req.params.id;
    const currentAdmin = req.admin;

    const targetAdmin = await prisma.admin.findUnique({
      where: { id: targetAdminId },
    });

    if (!targetAdmin) throw new ApiError(404, "Admin not found");

    if (currentAdmin.role === "administrator") {
    } else if (currentAdmin.role === "city_admin") {
      if (
        targetAdmin.id !== currentAdmin.id &&
        (targetAdmin.role !== "user" || targetAdmin.city !== currentAdmin.city)
      ) {
        throw new ApiError(403, "Access denied");
      }
    } else if (currentAdmin.role === "user") {
      if (targetAdmin.id !== currentAdmin.id) {
        throw new ApiError(403, "Access denied");
      }
    }

    res.json({
      success: true,
      adminData: transform(targetAdmin),
    });
  } catch (error) {
    console.log(error.message);
    res
      .status(error instanceof ApiError ? error.statusCode : 500)
      .json({ success: false, message: error.message });
  }
};

// ---------------------------------------------
// DELETE ADMIN
// ---------------------------------------------
export const deleteAdmin = async (req, res) => {
  try {
    const targetAdminId = req.params.id;
    const currentAdmin = req.admin;

    if (currentAdmin.role !== "administrator") {
      throw new ApiError(403, "Only administrators can delete accounts");
    }

    const targetAdmin = await prisma.admin.findUnique({
      where: { id: targetAdminId },
    });

    if (!targetAdmin) throw new ApiError(404, "Admin not found");

    if (targetAdmin.role === "administrator") {
      const count = await prisma.admin.count({
        where: { role: "administrator" },
      });

      if (count <= 1) {
        throw new ApiError(400, "Cannot delete the last administrator");
      }
    }

    await prisma.admin.delete({
      where: { id: targetAdminId },
    });

    res.json({
      success: true,
      message: "Account deleted successfully",
    });
  } catch (error) {
    console.log(error.message);
    res
      .status(error instanceof ApiError ? error.statusCode : 500)
      .json({ success: false, message: error.message });
  }
};
