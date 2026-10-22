import "dotenv/config";
import app from "./app";
import prisma from "./lib/prisma";
import { startBaselineScheduler } from "./modules/baseline/baseline.service";
import { resumeEnabledCameras } from "./modules/camera/camera.worker";

const PORT = process.env.PORT || 4000;

async function startServer() {
  try {
    await prisma.$connect();

    console.log("PostgreSQL connected successfully");

    app.listen(PORT, () => {
      console.log(
        `ElderCareAI Backend running on http://localhost:${PORT}`
      );
      void resumeEnabledCameras(); // sambungkan lagi kamera yang aktif (setelah server siap menerima frame)
    });

    startBaselineScheduler();
  } catch (error) {
    console.error("Database connection failed:", error);
    process.exit(1);
  }
}

startServer();