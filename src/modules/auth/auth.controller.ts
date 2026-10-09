import { Request, Response } from "express";
import {
  loginSchema,
  registerSchema,
} from "./auth.schema";
import {
  loginUser,
  registerUser,
  refreshAccessToken,
  logoutUser,
} from "./auth.service";
import prisma from "../../lib/prisma";
import { AuthRequest } from "../../common/middleware/auth.middleware";

export async function register(
  req: Request,
  res: Response
) {
  try {
    const data = registerSchema.parse(req.body);
    const user = await registerUser(data);

    return res.status(201).json({
      success: true,
      message: "Registrasi berhasil",
      data: user,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        success: false,
        message: "Data registrasi tidak valid",
        errors: error.issues,
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message || "Registrasi gagal",
    });
  }
}

export async function login(
  req: Request,
  res: Response
) {
  try {
    const data = loginSchema.parse(req.body);

    const result = await loginUser(
      data.email,
      data.password
    );

    return res.status(200).json({
      success: true,
      message: "Login berhasil",
      data: result,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        success: false,
        message: "Data login tidak valid",
        errors: error.issues,
      });
    }

    return res.status(401).json({
      success: false,
      message: error.message || "Login gagal",
    });
  }
}

export async function getMe(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "User belum terautentikasi",
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: req.user.userId,
      },
      select: {
        id: true,
        nama: true,
        email: true,
        noTelepon: true,
        role: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan",
      });
    }

    return res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error("Gagal mengambil data user:", error);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil data user",
    });
  }
}

export async function refresh(
  req: Request,
  res: Response
) {
  try {
    const refreshToken = req.body?.refreshToken;

    if (
      typeof refreshToken !== "string" ||
      refreshToken.trim().length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Refresh token wajib diisi",
      });
    }

    const result = await refreshAccessToken(refreshToken);

    return res.status(200).json({
      success: true,
      message: "Access token berhasil diperbarui",
      data: result,
    });
  } catch (error: any) {
    console.error("Refresh token gagal:", error.message);

    return res.status(401).json({
      success: false,
      message: error.message || "Refresh token tidak valid",
    });
  }
}

export async function logout(
  req: Request,
  res: Response
) {
  try {
    const refreshToken = req.body?.refreshToken;

    if (
      typeof refreshToken !== "string" ||
      refreshToken.trim().length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Refresh token wajib diisi",
      });
    }

    await logoutUser(refreshToken);

    return res.status(200).json({
      success: true,
      message: "Logout berhasil",
    });
  } catch (error: any) {
    console.error("Logout gagal:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message || "Logout gagal",
    });
  }
}