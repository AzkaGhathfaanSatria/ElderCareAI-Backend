
import { Response } from "express";
import { AuthRequest } from "../../common/middleware/auth.middleware";
import { getElders } from "./elders.service";

export async function listElders(
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

    const elders = await getElders(
      req.user.userId,
      req.user.role
    );

    return res.status(200).json({
      success: true,
      message: "Data lansia berhasil diambil",
      data: elders,
    });
  } catch (error) {
    console.error("Gagal mengambil data lansia:", error);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil data lansia",
    });
  }
}