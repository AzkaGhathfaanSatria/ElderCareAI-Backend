import { Request, Response } from "express";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from "./auth.schema";
import {
  loginUser,
  registerUser,
  refreshAccessToken,
  logoutUser,
  requestPasswordReset,
  resetPasswordWithToken,
} from "./auth.service";
import prisma from "../../lib/prisma";
import { AuthRequest } from "../../common/middleware/auth.middleware";

export async function register(
  req: Request,
  res: Response
) {
  try {
    const data = registerSchema.parse(req.body);

    // Pendaftaran publik tidak boleh membuat admin. Buat admin lewat `npm run create-admin`
    // (atau set ALLOW_ADMIN_REGISTER=true hanya untuk development).
    if (data.role === "admin" && process.env.ALLOW_ADMIN_REGISTER !== "true") {
      return res.status(403).json({
        success: false,
        message: "Pendaftaran akun admin tidak diizinkan.",
      });
    }

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

export async function forgotPassword(req: Request, res: Response) {
  const generic = { success: true, message: "Jika email terdaftar, tautan reset password akan dikirim." };
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    // Diproses di belakang; respons selalu sama supaya email terdaftar tidak bisa ditebak.
    void requestPasswordReset(email).catch((e) => console.error("requestPasswordReset", e));
    return res.status(200).json(generic);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ success: false, message: "Email tidak valid" });
    }
    return res.status(200).json(generic);
  }
}

export async function resetPassword(req: Request, res: Response) {
  try {
    const { token, password } = resetPasswordSchema.parse(req.body);
    await resetPasswordWithToken(token, password);
    return res.status(200).json({ success: true, message: "Password berhasil diubah. Silakan login." });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ success: false, message: error.issues?.[0]?.message ?? "Data tidak valid" });
    }
    return res.status(400).json({ success: false, message: error.message || "Reset password gagal" });
  }
}
