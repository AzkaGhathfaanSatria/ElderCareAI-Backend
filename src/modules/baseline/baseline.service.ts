import prisma from "../../lib/prisma";
import { aiEnabled, trainBaseline, type BaselineFeatureRow, type PolaNormal } from "../../integrations/aiClient";

/**
 * Baseline perilaku per lansia (FR-04).
 * Cold start: sebelum data cukup, deteksi anomali memakai baseline umum dari model.
 * Setelah itu pola normal dipelajari dari riwayat wearable lansia itu sendiri.
 */
const COLD_START_DAYS = Number(process.env.BASELINE_COLD_START_DAYS ?? 7);
const MIN_SAMPLES = Number(process.env.BASELINE_MIN_SAMPLES ?? 100);
const WINDOW_DAYS = 14; // riwayat yang dipakai melatih
const MAX_TRAIN_ROWS = 3000;
const EXCLUDE_AROUND_ALERT_MS = 10 * 60_000; // pembacaan di sekitar alert tidak dianggap "normal"
const REFRESH_AFTER_MS = 24 * 3600_000;

export const FEATURES: { key: keyof BaselineFeatureRow; label: string; unit: string }[] = [
  { key: "heart_rate", label: "Detak jantung", unit: "BPM" },
  { key: "oxygen_level", label: "Saturasi oksigen (SpO₂)", unit: "%" },
  { key: "temperature", label: "Suhu tubuh", unit: "°C" },
  { key: "heart_rate_variability", label: "Variabilitas detak (HRV)", unit: "ms" },
  { key: "acceleration_magnitude", label: "Akselerasi", unit: "" },
  { key: "gyro_magnitude", label: "Gerak (gyro)", unit: "" },
];

const completeRow = {
  detakJantung: { not: null },
  oxygenLevel: { not: null },
  temperature: { not: null },
  accelerationMagnitude: { not: null },
  gyroMagnitude: { not: null },
  heartRateVariability: { not: null },
} as const;

async function wearableIds(idLansia: number) {
  const w = await prisma.wearable.findMany({ where: { idLansia }, select: { id: true } });
  return w.map((x) => x.id);
}

function toRow(r: { detakJantung: number | null; oxygenLevel: number | null; temperature: number | null; accelerationMagnitude: number | null; gyroMagnitude: number | null; heartRateVariability: number | null }): BaselineFeatureRow {
  return {
    heart_rate: r.detakJantung as number,
    oxygen_level: r.oxygenLevel as number,
    temperature: r.temperature as number,
    acceleration_magnitude: r.accelerationMagnitude as number,
    gyro_magnitude: r.gyroMagnitude as number,
    heart_rate_variability: r.heartRateVariability as number,
  };
}

export async function latestBaseline(idLansia: number) {
  return prisma.baseline.findFirst({ where: { idLansia }, orderBy: { tanggalDibentuk: "desc" } });
}

/** Ringkasan data yang sudah terkumpul untuk membentuk baseline. */
export async function dataProgress(idLansia: number) {
  const ids = await wearableIds(idLansia);
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000);
  const agg = await prisma.wearableData.aggregate({
    where: { idWearable: { in: ids }, timestamp: { gte: since }, ...completeRow },
    _count: { _all: true },
    _min: { timestamp: true },
    _max: { timestamp: true },
  });
  const samples = agg._count._all;
  const days = agg._min.timestamp && agg._max.timestamp ? (agg._max.timestamp.getTime() - agg._min.timestamp.getTime()) / 86400_000 : 0;
  return { samples, days: Math.round(days * 10) / 10, ready: samples >= MIN_SAMPLES && days >= COLD_START_DAYS };
}

export interface BaselineStatus {
  status: "belajar" | "aktif";
  aiEnabled: boolean;
  daysCollected: number;
  daysRequired: number;
  samples: number;
  samplesRequired: number;
  updatedAt: string | null;
  zThreshold: number | null;
  fitur: { key: string; label: string; unit: string; normal: number | null; current: number | null; status: "Normal" | "Berubah" | null }[];
}

export async function baselineStatus(idLansia: number): Promise<BaselineStatus> {
  const [progress, base, ids] = await Promise.all([dataProgress(idLansia), latestBaseline(idLansia), wearableIds(idLansia)]);
  const pola = base ? (base.polaNormal as unknown as PolaNormal) : null;

  // Bandingkan pembacaan terbaru dengan pola normal lansia (skor z per metrik).
  const latest = pola
    ? await prisma.wearableData.findFirst({ where: { idWearable: { in: ids }, ...completeRow }, orderBy: { timestamp: "desc" } })
    : null;
  const cur = latest ? toRow(latest) : null;

  return {
    status: pola ? "aktif" : "belajar",
    aiEnabled,
    daysCollected: progress.days,
    daysRequired: COLD_START_DAYS,
    samples: progress.samples,
    samplesRequired: MIN_SAMPLES,
    updatedAt: base ? base.tanggalDibentuk.toISOString() : null,
    zThreshold: pola ? pola.z_threshold : null,
    fitur: FEATURES.map((f) => {
      const normal = pola ? pola.median[f.key] : null;
      const current = cur ? cur[f.key] : null;
      const z = pola && cur ? Math.abs(cur[f.key] - pola.median[f.key]) / pola.skala[f.key] : null;
      return { ...f, normal, current, status: z === null || !pola ? null : z > pola.z_threshold ? "Berubah" : "Normal" };
    }),
  };
}

export type TrainResult = { ok: true; baselineId: number } | { ok: false; reason: string; code: 400 | 503 };

/** Latih (atau latih ulang) baseline satu lansia. Gagal dengan alasan jelas bila data belum cukup. */
export async function trainElderBaseline(idLansia: number): Promise<TrainResult> {
  if (!aiEnabled) return { ok: false, code: 503, reason: "Layanan AI belum aktif (AI_SERVICE_URL belum diatur)." };

  const progress = await dataProgress(idLansia);
  if (!progress.ready) {
    return {
      ok: false,
      code: 400,
      reason: `Data belum cukup: terkumpul ${progress.days} dari ${COLD_START_DAYS} hari dan ${progress.samples} dari ${MIN_SAMPLES} pembacaan lengkap.`,
    };
  }

  const ids = await wearableIds(idLansia);
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000);
  const [rows, alerts] = await Promise.all([
    prisma.wearableData.findMany({
      where: { idWearable: { in: ids }, timestamp: { gte: since }, ...completeRow },
      orderBy: { timestamp: "desc" },
      take: 20000,
    }),
    prisma.alert.findMany({ where: { idLansia, waktuDeteksi: { gte: since } }, select: { waktuDeteksi: true } }),
  ]);

  // Buang pembacaan di sekitar alert agar kejadian abnormal tidak masuk ke "pola normal".
  const alertTimes = alerts.map((a) => a.waktuDeteksi.getTime());
  let clean = rows.filter((r) => !alertTimes.some((t) => Math.abs(r.timestamp.getTime() - t) <= EXCLUDE_AROUND_ALERT_MS));
  if (clean.length < MIN_SAMPLES) return { ok: false, code: 400, reason: "Data normal belum cukup setelah membuang pembacaan di sekitar alert." };

  // Ratakan ke maksimal MAX_TRAIN_ROWS titik (tersebar merata sepanjang waktu).
  if (clean.length > MAX_TRAIN_ROWS) {
    const step = clean.length / MAX_TRAIN_ROWS;
    clean = Array.from({ length: MAX_TRAIN_ROWS }, (_, i) => clean[Math.floor(i * step)]!);
  }

  const trained = await trainBaseline(clean.map(toRow));
  if (!trained) return { ok: false, code: 503, reason: "Layanan AI tidak dapat membentuk baseline saat ini." };

  const saved = await prisma.baseline.create({
    data: { idLansia, polaNormal: trained.pola_normal as object, versiModel: trained.versi_model.slice(0, 50) },
  });
  return { ok: true, baselineId: saved.id };
}

/**
 * Penjadwal sederhana (tanpa Redis): tiap interval, latih ulang baseline lansia yang punya data baru
 * bila belum punya baseline atau baseline-nya lebih tua dari 24 jam.
 */
export function startBaselineScheduler() {
  if (!aiEnabled) return;
  const delayMs = Number(process.env.BASELINE_SCHEDULER_DELAY_SEC ?? 60) * 1000;
  const everyMs = Number(process.env.BASELINE_SCHEDULER_INTERVAL_MIN ?? 360) * 60_000;

  const run = async () => {
    try {
      const recent = await prisma.wearableData.findMany({
        where: { timestamp: { gte: new Date(Date.now() - 2 * 86400_000) } },
        distinct: ["idWearable"],
        select: { idWearable: true },
      });
      const wearables = await prisma.wearable.findMany({ where: { id: { in: recent.map((r) => r.idWearable) } }, select: { idLansia: true } });
      for (const idLansia of new Set(wearables.map((w) => w.idLansia))) {
        const base = await latestBaseline(idLansia);
        if (base && Date.now() - base.tanggalDibentuk.getTime() < REFRESH_AFTER_MS) continue;
        const r = await trainElderBaseline(idLansia);
        if (r.ok) console.log(`[baseline] lansia ${idLansia}: baseline #${r.baselineId} dibentuk`);
      }
    } catch (e) {
      console.error("[baseline] penjadwal gagal:", (e as Error).message);
    }
  };

  setTimeout(run, delayMs).unref();
  setInterval(run, everyMs).unref();
}
