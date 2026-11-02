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

    if ((process.env.JWT_SECRET ?? "").length < 32) {
      console.warn("PERINGATAN: JWT_SECRET kurang dari 32 karakter. Pakai string acak panjang sebelum dipakai di luar jaringan rumah.");
    }
    if (!process.env.CORS_ORIGINS) {
      console.warn("PERINGATAN: CORS_ORIGINS belum diisi, semua asal diizinkan. Isi dengan alamat web kamu untuk produksi.");
    }

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