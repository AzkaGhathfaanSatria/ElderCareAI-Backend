import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../../lib/prisma";
import { sendMail } from "../../integrations/mailer";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET belum diset di .env");
}

function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

function hashRefreshToken(token: string) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

export async function registerUser(data: {
  nama: string;
  email: string;
  password: string;
  noTelepon?: string;
  role?: "admin" | "keluarga" | "tenaga_medis";
}) {
  const existingUser = await prisma.user.findUnique({
    where: {
      email: data.email,
    },
  });

  if (existingUser) {
    throw new Error("Email sudah terdaftar");
  }

  const hashedPassword = await bcrypt.hash(data.password, 10);

  const user = await prisma.user.create({
    data: {
      nama: data.nama,
      email: data.email,
      password: hashedPassword,
      noTelepon: data.noTelepon,
      role: data.role ?? "keluarga",
    },
  });

  return {
    id: user.id,
    nama: user.nama,
    email: user.email,
    role: user.role,
  };
}

export async function loginUser(
  email: string,
  password: string
) {
  const user = await prisma.user.findUnique({
    where: {
      email,
    },
  });

  if (!user) {
    throw new Error("Email atau password salah");
  }

  const passwordValid = await bcrypt.compare(
    password,
    user.password
  );

  if (!passwordValid) {
    throw new Error("Email atau password salah");
  }

  if (user.status !== "aktif") {
    throw new Error("Akun dinonaktifkan. Hubungi admin.");
  }

  const accessToken = jwt.sign(
    {
      userId: user.id,
      role: user.role,
    },
    JWT_SECRET,
    {
      expiresIn: "15m",
    }
  );

  const refreshToken = generateRefreshToken();

  const refreshTokenHash = hashRefreshToken(refreshToken);

  await prisma.refreshToken.create({
    data: {
      idUser: user.id,
      tokenHash: refreshTokenHash,
      expiresAt: new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      ),
    },
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      nama: user.nama,
      email: user.email,
      role: user.role,
    },
  };
}

export async function refreshAccessToken(
  refreshToken: string
) {
  const tokenHash = hashRefreshToken(refreshToken);

  const storedToken = await prisma.refreshToken.findFirst({
    where: {
      tokenHash,
      revokedAt: null,
    },
  });

  if (!storedToken) {
    throw new Error("Refresh token tidak valid");
  }

  if (storedToken.expiresAt < new Date()) {
    throw new Error("Refresh token sudah expired");
  }

  const user = await prisma.user.findUnique({
    where: {
      id: storedToken.idUser,
    },
  });

  if (!user) {
    throw new Error("User tidak ditemukan");
  }

  if (user.status !== "aktif") {
    throw new Error("Akun dinonaktifkan. Hubungi admin.");
  }

  const accessToken = jwt.sign(
    {
      userId: user.id,
      role: user.role,
    },
    JWT_SECRET,
    {
      expiresIn: "15m",
    }
  );

  return {
    accessToken,
  };
}

export async function logoutUser(
  refreshToken: string
) {
  const tokenHash = hashRefreshToken(refreshToken);

  const storedToken = await prisma.refreshToken.findFirst({
    where: {
      tokenHash,
      revokedAt: null,
    },
  });

  if (!storedToken) {
    return;
  }

  await prisma.refreshToken.update({
    where: {
      id: storedToken.id,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

// ---------------- reset password ----------------

const RESET_TTL_MS = 60 * 60 * 1000; // 1 jam
const RESET_COOLDOWN_MS = 60 * 1000; // minimal 1 menit antar permintaan per akun

/** Selalu "berhasil" ke pemanggil (tidak membocorkan apakah email terdaftar). */
export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "aktif") return;

  const last = await prisma.passwordResetToken.findFirst({ where: { idUser: user.id }, orderBy: { createdAt: "desc" } });
  if (last && Date.now() - last.createdAt.getTime() < RESET_COOLDOWN_MS) return;

  const token = crypto.randomBytes(32).toString("hex");
  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({ where: { idUser: user.id, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.passwordResetToken.create({
      data: { idUser: user.id, tokenHash: hashRefreshToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    }),
  ]);

  const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const link = `${base}/reset-password?token=${token}`;
  await sendMail(
    user.email,
    "Reset password ElderCare AI",
    `Halo ${user.nama},\n\nKami menerima permintaan reset password. Buka tautan berikut (berlaku 1 jam):\n${link}\n\nJika bukan Anda yang meminta, abaikan email ini.`,
  );
}

export async function resetPasswordWithToken(token: string, newPassword: string) {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashRefreshToken(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new Error("Tautan reset tidak valid atau sudah kedaluwarsa");
  }
  const hashed = await bcrypt.hash(newPassword, 10);
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.idUser }, data: { password: hashed } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: now } }),
    // semua sesi lama dicabut
    prisma.refreshToken.updateMany({ where: { idUser: record.idUser, revokedAt: null }, data: { revokedAt: now } }),
  ]);
}
