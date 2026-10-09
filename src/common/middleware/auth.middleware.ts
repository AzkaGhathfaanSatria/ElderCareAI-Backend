import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET belum diset di .env");
}

export interface AuthRequest extends Request {
  user?: {
    userId: number;
    role: "admin" | "keluarga" | "tenaga_medis";
  };
}

export function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: "Token tidak ditemukan",
      });
    }

    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({
        success: false,
        message: "Format token tidak valid",
      });
    }

    const token = parts[1];

    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: number;
      role: "admin" | "keluarga" | "tenaga_medis";
    };

    req.user = {
      userId: decoded.userId,
      role: decoded.role,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Token tidak valid atau sudah expired",
    });
  }
}