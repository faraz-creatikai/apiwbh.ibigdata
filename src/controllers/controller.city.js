import prisma from "../config/prismaClient.js";
import ApiError from "../utils/ApiError.js";

export const transformCity = (city) => ({
  _id: city.id, // mimic MongoDB's _id
  Name: city.Name,
  Status: city.Status,
  createdAt: city.createdAt,
  updatedAt: city.updatedAt,
});

// GET ALL CITIES
export const getCity = async (req, res, next) => {
  try {
    const { keyword, limit } = req.query;

    let where = {};
    if (keyword) {
      where.Name = { contains: keyword, mode: "insensitive" };
    }

    const cities = await prisma.city.findMany({
      where,
      orderBy: { Name: "asc" },
      take: limit ? Number(limit) : undefined,
    });

    res.status(200).json(cities.map(transformCity));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// GET CITY BY ID
export const getCityById = async (req, res, next) => {
  try {
    const city = await prisma.city.findUnique({
      where: { id: req.params.id },
    });

    if (!city) return next(new ApiError(404, "City not found"));

    res.status(200).json(transformCity(city));
  } catch (error) {
    next(new ApiError(500, error.message));
  }
};

// CREATE CITY
export const createCity = async (req, res, next) => {
  try {
    const { Name, Status } = req.body;

    const newCity = await prisma.city.create({
      data: { Name, Status },
    });

    res.status(201).json(transformCity(newCity));
  } catch (error) {
    next(new ApiError(400, error.message));
  }
};

// UPDATE CITY
export const updateCity = async (req, res, next) => {
  try {
    const { id } = req.params;

    const updatedCity = await prisma.city.update({
      where: { id },
      data: req.body,
    });

    res.status(200).json(transformCity(updatedCity));
  } catch (error) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "City not found"));
    }
    next(new ApiError(400, error.message));
  }
};

// DELETE CITY
export const deleteCity = async (req, res, next) => {
  try {
    const id = req.params.id;

    // Delete all SubLocations linked to this City
    await prisma.subLocation.deleteMany({
      where: { cityId: id },
    });
    
    // Delete all Locations linked to this City
    await prisma.location.deleteMany({
      where: { cityId: id },
    });

    //  Delete the City
    await prisma.city.delete({
      where: { id },
    });

    

    res.status(200).json({ message: "City deleted successfully" });
  } catch (error) {
    if (error.code === "P2025") {
      return next(new ApiError(404, "City not found"));
    }
    next(new ApiError(500, error.message));
  }
};
