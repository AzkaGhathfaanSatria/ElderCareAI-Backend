import { z } from "zod";

export const registerSchema = z.object({
  nama: z.string().min(2).max(100),
  email: z.string().email().max(150),
  password: z.string().min(8),
  noTelepon: z.string().max(20).optional(),
  role: z.enum(["admin", "keluarga", "tenaga_medis"]).default("keluarga"),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});