import express from "express";
import cors from "cors";
import authRoutes from "./modules/auth/auth.routes";
import monitoringRoutes from "./modules/monitoring/monitoring.routes";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    message: "ElderCareAI Backend is running",
  });
});

app.use("/auth", authRoutes);
app.use("/", monitoringRoutes);

export default app;