import express from "express";
import cors from "cors";
import authRoutes from "./modules/auth/auth.routes";
import monitoringRoutes from "./modules/monitoring/monitoring.routes";
import managementRoutes from "./modules/monitoring/management.routes";
import streamRoutes from "./modules/monitoring/stream.routes";
import ingestRoutes from "./modules/ingest/ingest.routes";
import prisma from "./lib/prisma";
import { pingAi } from "./integrations/aiClient";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());

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
app.use("/", monitoringRoutes);
app.use("/", managementRoutes);

export default app;