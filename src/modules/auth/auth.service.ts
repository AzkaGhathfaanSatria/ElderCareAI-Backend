import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../../lib/prisma";

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