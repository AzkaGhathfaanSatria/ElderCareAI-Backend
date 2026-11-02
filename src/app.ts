import express from "express";
import cors from "cors";
import authRoutes from "./modules/auth/auth.routes";
import monitoringRoutes from "./modules/monitoring/monitoring.routes";
import managementRoutes from "./modules/monitoring/management.routes";
import streamRoutes from "./modules/monitoring/stream.routes";
import ingestRoutes from "./modules/ingest/ingest.routes";
import cameraRoutes from "./modules/camera/camera.routes";
import prisma from "./lib/prisma";
import { pingAi } from "./integrations/aiClient";

const app = express();

// Di belakang proxy/Docker, req.ip harus alamat klien asli supaya pembatas login bekerja per pengguna.
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? true : process.env.TRUST_PROXY);

// CORS_ORIGINS="https://app.contoh.id,http://localhost:3000" membatasi asal yang boleh memanggil API.
// Tanpa variabel ini semua asal diizinkan (nyaman untuk LAN/pengembangan, jangan dipakai di publik).
const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  const [database, ai] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => "ok" as const).catch(() => "down" as const),
    pingAi(),
  ]);
  res.json({
    success: true,
    message: "ElderCareAI Backend is running",
    database,
    ai,
  });
});

app.use("/auth", authRoutes);
app.use("/", streamRoutes); // auth sendiri (token via query)
app.use("/", ingestRoutes); // auth sendiri (X-Device-Key)
app.use("/", cameraRoutes); // /devices/:id/stream*
app.use("/", monitoringRoutes);
app.use("/", managementRoutes);

export default app;