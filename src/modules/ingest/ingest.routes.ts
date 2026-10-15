import { createHash } from "crypto";
import express, { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { publish } from "../../common/events";
import { evaluateSensor, evaluateWearable, raiseFall } from "../alerts/alert.engine";
import { inferPose, isFallClass } from "../../integrations/aiClient";

export function hashDeviceKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

interface DeviceRequest extends Request {
  wearable?: { id: number; idLansia: number };
}

/** Autentikasi perangkat lewat header X-Device-Key (key asli tidak disimpan, hanya hash-nya). */
async function deviceAuth(req: DeviceRequest, res: Response, next: NextFunction) {
  const key = req.header("x-device-key");
  if (!key) return res.status(401).json({ success: false, message: "Header X-Device-Key wajib diisi" });
  try {
    const w = await prisma.wearable.findFirst({ where: { deviceKeyHash: hashDeviceKey(key) }, select: { id: true, idLansia: true } });
    if (!w) return res.status(401).json({ success: false, message: "Device key tidak valid" });
    req.wearable = w;
    next();
  } catch (e) {
    console.error("deviceAuth", e);
    return res.status(500).json({ success: false, message: "Gagal memverifikasi perangkat" });
  }
}

const reading = z
  .object({
    timestamp: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "timestamp tidak valid"),
    heartRate: z.number().int().min(20).max(250).optional(),
    sleepHours: z.number().min(0).max(24).optional(),
    battery: z.number().int().min(0).max(100).optional(),
    moving: z.boolean().optional(),
    // Metrik untuk model AI sensor. acceleration/gyro = norma vektor x,y,z.
    oxygenLevel: z.number().min(50).max(100).optional(),
    temperature: z.number().min(30).max(45).optional(),
    accelerationMagnitude: z.number().min(0).max(100).optional(),
    gyroMagnitude: z.number().min(0).max(100).optional(),
    heartRateVariability: z.number().min(0).max(300).optional(),
  })
  .refine(
    (r) =>
      r.heartRate !== undefined || r.sleepHours !== undefined || r.moving !== undefined || r.oxygenLevel !== undefined ||
      r.temperature !== undefined || r.accelerationMagnitude !== undefined || r.gyroMagnitude !== undefined || r.heartRateVariability !== undefined,
    { message: "Minimal satu field data (heartRate, sleepHours, moving, oxygenLevel, ...) harus ada" },
  );

const MAX_BATCH = 500;
const router = Router();

router.post("/ingest/wearable", deviceAuth, async (req: DeviceRequest, res) => {
  try {
    const raw = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.readings) ? req.body.readings : [req.body];
    if (raw.length === 0 || raw.length > MAX_BATCH) {
      return res.status(400).json({ success: false, message: `Jumlah data harus 1-${MAX_BATCH} per request` });
    }
    const parsed = z.array(reading).parse(raw);
    const { id: idWearable, idLansia } = req.wearable!;

    const limit = Date.now() + 5 * 60_000;
    let rejected = 0;
    const byTs = new Map<number, z.infer<typeof reading>>();
    for (const r of parsed) {
      const t = Date.parse(r.timestamp);
      if (t > limit) { rejected++; continue; }
      byTs.set(t, r);
    }

    const times = [...byTs.keys()].map((t) => new Date(t));
    const existing = await prisma.wearableData.findMany({ where: { idWearable, timestamp: { in: times } }, select: { timestamp: true } });
    const seen = new Set(existing.map((e) => e.timestamp.getTime()));
    const fresh = [...byTs.entries()].filter(([t]) => !seen.has(t));
    const duplicates = byTs.size - fresh.length;

    if (fresh.length > 0) {
      const vitalRows = fresh.map(([t, r]) => ({
        idWearable,
        detakJantung: r.heartRate ?? null,
        polaTidur: r.sleepHours !== undefined ? { jam: r.sleepHours } : undefined,
        timestamp: new Date(t),
      }));
      const dataRows = fresh.map(([t, r], i) => ({
        ...vitalRows[i],
        oxygenLevel: r.oxygenLevel ?? null,
        temperature: r.temperature ?? null,
        accelerationMagnitude: r.accelerationMagnitude ?? null,
        gyroMagnitude: r.gyroMagnitude ?? null,
        heartRateVariability: r.heartRateVariability ?? null,
      }));

      const moving = fresh.filter(([, r]) => r.moving);
      let sensorId: number | null = null;
      if (moving.length) {
        const sensor =
          (await prisma.sensorIot.findFirst({ where: { idLansia, tipeSensor: "gerak", lokasiPemasangan: "Wearable" } })) ??
          (await prisma.sensorIot.create({ data: { idLansia, tipeSensor: "gerak", lokasiPemasangan: "Wearable" } }));
        sensorId = sensor.id;
      }

      const newestWithBattery = [...fresh].filter(([, r]) => r.battery !== undefined).sort((a, b) => b[0] - a[0])[0];
      await prisma.$transaction([
        prisma.wearableData.createMany({ data: dataRows, skipDuplicates: true }),
        prisma.vitalSign.createMany({ data: vitalRows }),
        ...(sensorId !== null
          ? [prisma.activity.createMany({ data: moving.map(([t]) => ({ idSensor: sensorId!, jenisAktivitas: "bergerak", timestamp: new Date(t) })) })]
          : []),
        prisma.wearable.update({
          where: { id: idWearable },
          data: { lastSeen: new Date(), ...(newestWithBattery ? { statusBaterai: newestWithBattery[1].battery } : {}) },
        }),
      ]);

      // Balas cepat (202), analisis jalan di belakang. Hanya data baru (<10 menit) yang memicu alert/realtime.
      const newest = Math.max(...fresh.map(([t]) => t));
      if (Date.now() - newest < 10 * 60_000) {
        publish(idLansia, "vital", { idWearable });
        void evaluateWearable(idWearable, idLansia).catch((e) => console.error("evaluateWearable", e));
        // Pembacaan terbaru yang lengkap (6 metrik) -> analisis model AI (jatuh + anomali)
        void evaluateSensor(idWearable, idLansia, new Date(newest)).catch((e) => console.error("evaluateSensor", e));
      }
    } else {
      await prisma.wearable.update({ where: { id: idWearable }, data: { lastSeen: new Date() } });
    }

    return res.status(202).json({ success: true, accepted: fresh.length, duplicates, rejected });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ success: false, message: "Data tidak valid", errors: e.issues });
    }
    console.error("ingest wearable", e);
    return res.status(500).json({ success: false, message: "Gagal menyimpan data" });
  }
});

// ---------------------------------------------------------------- kamera

// Jatuh visual dianggap nyata bila ada >= FALL_FRAMES_REQUIRED deteksi "Fall" (confidence >= FALL_MIN_CONF)
// dari kamera yang sama dalam FALL_WINDOW_SEC detik. Frame normal tidak disimpan (hemat DB + privasi).
const FALL_FRAMES_REQUIRED = Number(process.env.FALL_FRAMES_REQUIRED ?? 3);
const FALL_WINDOW_SEC = Number(process.env.FALL_WINDOW_SEC ?? 10);
const FALL_MIN_CONF = Number(process.env.FALL_MIN_CONF ?? 0.5);

interface CameraRequest extends Request {
  camera?: { id: number; idLansia: number };
}

async function cameraAuth(req: CameraRequest, res: Response, next: NextFunction) {
  const key = req.header("x-device-key");
  if (!key) return res.status(401).json({ success: false, message: "Header X-Device-Key wajib diisi" });
  try {
    const c = await prisma.camera.findFirst({ where: { deviceKeyHash: hashDeviceKey(key) }, select: { id: true, idLansia: true } });
    if (!c) return res.status(401).json({ success: false, message: "Device key tidak valid" });
    req.camera = c;
    next();
  } catch (e) {
    console.error("cameraAuth", e);
    return res.status(500).json({ success: false, message: "Gagal memverifikasi kamera" });
  }
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Kirim satu frame sebagai badan mentah dengan Content-Type image/jpeg|png|webp (maks 8 MB). */
router.post("/ingest/camera", cameraAuth, express.raw({ type: IMAGE_TYPES, limit: "8mb" }), async (req: CameraRequest, res) => {
  try {
    const frame = req.body as unknown;
    if (!Buffer.isBuffer(frame) || frame.length === 0) {
      return res.status(400).json({ success: false, message: "Kirim gambar mentah dengan Content-Type image/jpeg, image/png, atau image/webp" });
    }
    const { id: idKamera, idLansia } = req.camera!;

    const pose = await inferPose(frame, req.header("content-type")!.split(";")[0]!);
    if (!pose) return res.status(503).json({ success: false, message: "Layanan AI tidak tersedia. Coba kirim ulang." });
    await prisma.camera.update({ where: { id: idKamera }, data: { lastSeen: new Date() } });

    const falls = pose.deteksi.filter((d) => isFallClass(d.kelas) && d.confidence >= FALL_MIN_CONF);
    const summary = pose.deteksi.map((d) => ({ kelas: d.kelas, confidence: d.confidence }));
    if (falls.length === 0) {
      return res.json({ success: true, fall: false, fallFrames: 0, required: FALL_FRAMES_REQUIRED, alertRaised: false, deteksi: summary });
    }

    const best = falls.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const row = await prisma.yoloDetection.create({
      data: {
        idKamera,
        idLansia,
        kelas: best.kelas.slice(0, 50),
        confidence: best.confidence,
        bbox: best.kotak_xyxy,
        keypoints: best.keypoints ?? undefined,
        versiModel: pose.versi_model.slice(0, 50),
      },
    });

    const fallFrames = await prisma.yoloDetection.count({
      where: { idKamera, kelas: best.kelas.slice(0, 50), confidence: { gte: FALL_MIN_CONF }, timestamp: { gte: new Date(Date.now() - FALL_WINDOW_SEC * 1000) } },
    });

    let alertRaised = false;
    if (fallFrames >= FALL_FRAMES_REQUIRED) {
      const alert = await raiseFall({ idLansia, jenis: "Jatuh terdeteksi (kamera)", idDeteksi: row.id });
      alertRaised = Boolean(alert);
    }
    return res.json({ success: true, fall: true, fallFrames, required: FALL_FRAMES_REQUIRED, alertRaised, deteksi: summary });
  } catch (e) {
    console.error("ingest camera", e);
    return res.status(500).json({ success: false, message: "Gagal memproses frame" });
  }
});

export default router;
