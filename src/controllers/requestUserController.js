import bcrypt from "bcryptjs";
import { genrateToken } from "../config/adminjwt.js";
import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";



export const acceptRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const currentAdmin = req.admin;

/*         if (currentAdmin.role !== "administrator") {
            throw new ApiError(403, "Only administrators can accept requests");
        }
 */
        if (!id) {
            throw new ApiError(400, "User ID is required");
        }

        // Find the request user
        const requestUser = await prisma.requestUser.findUnique({
            where: { id },
        });

        if (!requestUser) {
            throw new ApiError(404, "Request user not found");
        }

        // Check if email already exists in admin table
        const existingAdmin = await prisma.admin.findUnique({
            where: { email: requestUser.email },
        });

        if (existingAdmin) {
            throw new ApiError(409, "An admin with this email already exists");
        }

        // Create new admin record using the data from requestUser
        const newAdmin = await prisma.admin.create({
            data: {
                name: requestUser.name,
                email: requestUser.email,
                password: requestUser.password, // password is already hashed in requestUser
                role: "user",
                city: requestUser.city || null,
                phone: requestUser.phone || null,
            },
        });

        // Delete the user from requestUser table
        await prisma.requestUser.delete({
            where: { id },
        });

        res.status(201).json({
            success: true,
            adminData: newAdmin,
            message: "Request accepted and user added successfully",
        });
    } catch (error) {
        console.log(error.message);
        res
            .status(error instanceof ApiError ? error.statusCode : 500)
            .json({ success: false, message: error.message });
    }
};


export const denyRequest = async (req, res) => {
    try {
        const { id } = req.params;

        const currentAdmin = req.admin;

        if (currentAdmin.role !== "administrator") {
            throw new ApiError(403, "Only administrators can deny request");
        }

        if (!id) {
            throw new ApiError(400, "User ID is required");
        }

        // Check if user exists
        const requestUser = await prisma.requestUser.findUnique({
            where: { id },
        });

        if (!requestUser) {
            throw new ApiError(404, "Request user not found");
        }

        // Delete from RequestUser table
        await prisma.requestUser.delete({
            where: { id },
        });

        res.status(200).json({
            success: true,
            message: "Request denied and user removed successfully",
        });
    } catch (error) {
        console.log(error.message);
        res
            .status(error instanceof ApiError ? error.statusCode : 500)
            .json({ success: false, message: error.message });
    }
};


export const getAllRequestUser = async (req, res) => {
    try {
        const requestUsers = await prisma.requestUser.findMany();

        res.status(200).json({
            success: true,
            count: requestUsers.length,
            data: requestUsers,
        });
    } catch (error) {
        console.log(error.message);
        res
            .status(error instanceof ApiError ? error.statusCode : 500)
            .json({ success: false, message: error.message });
    }
};






export const newUserSignup = async (req, res) => {
    const { name, email, password,phone } = req.body;

    try {
        if (!email || !password || !name || !phone) {
            throw new ApiError(400, "Missing required details");
        }

        // Check if email already exists inside RequestUser
        const existingRequestUser = await prisma.requestUser.findFirst({
            where: { email },
        });

        if (existingRequestUser) {
            throw new ApiError(409, "Account already exists");
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create new RequestUser
        const newUser = await prisma.requestUser.create({
            data: {
                name,
                email,
                password: hashedPassword,
                phone
            },
        });

        const token = genrateToken(newUser.id);

        res.status(201).json({
            success: true,
            userData: newUser,
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
