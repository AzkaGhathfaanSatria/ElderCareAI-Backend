/**
 * Klien HTTP internal ke layanan AI (Flask). Kalau AI_SERVICE_URL kosong atau layanan mati,
 * fungsi mengembalikan null supaya ingest tetap jalan (AI bersifat pelengkap, bukan syarat).
 */
const BASE = process.env.AI_SERVICE_URL?.replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 3000);

export interface SensorInput {
  heart_rate: number;
  oxygen_level: number;
  temperature: number;
  acceleration_magnitude: number;
  gyro_magnitude: number;
  heart_rate_variability: number;
  riwayat_gyro_magnitude: number[];
  /** Baseline per lansia (hasil /baseline/train). Tanpa ini model memakai baseline umum. */
  pola_normal?: unknown;
}

export interface SensorResult {
  status: "JATUH" | "ANOMALI" | "NORMAL";
  peluang_jatuh: number;
  anomali: boolean;
  skor_z: number;
  fitur_penyebab: string;
  skor_iso: number;
  baseline?: "lansia" | "umum";
  versi_model: string;
}

export const aiEnabled = Boolean(BASE);

/** Cek cepat layanan AI untuk /health: "ok" | "down" | "nonaktif" (AI_SERVICE_URL tidak diatur). */
export async function pingAi(): Promise<"ok" | "down" | "nonaktif"> {
  if (!BASE) return "nonaktif";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${BASE}/health`, { signal: ctrl.signal });
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

export async function inferSensor(input: SensorInput): Promise<SensorResult | null> {
  if (!BASE) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/infer/sensor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error("AI /infer/sensor", res.status, await res.text().catch(() => ""));
      return null;
    }
    return (await res.json()) as SensorResult;
  } catch (e) {
    console.error("AI service tidak terjangkau:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface PoseDetection {
  kelas: string;
  confidence: number;
  kotak_xyxy: number[];
  keypoints: number[][] | null;
}

export interface PoseResult {
  jatuh_terdeteksi: boolean;
  deteksi: PoseDetection[];
  versi_model: string;
}

const POSE_TIMEOUT_MS = Number(process.env.AI_POSE_TIMEOUT_MS ?? 10000);

/** Kelas YOLO yang berarti jatuh: "Fall" ya, "Non-Fall" tidak. */
export function isFallClass(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/_/g, "-");
  return n.includes("fall") && !/^(non|no-|not)/.test(n);
}

/**
 * Kirim satu frame ke /infer/pose. Frame hanya hidup di memori (NFR-06): tidak ditulis ke disk
 * dan tidak dicatat di log. Mengembalikan null bila layanan AI mati / tidak diatur.
 */
export async function inferPose(frame: Buffer, mime: string): Promise<PoseResult | null> {
  if (!BASE) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POSE_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(frame)], { type: mime }), "frame");
    const res = await fetch(`${BASE}/infer/pose`, { method: "POST", body: form, signal: ctrl.signal });
    if (!res.ok) {
      console.error("AI /infer/pose", res.status);
      return null;
    }
    return (await res.json()) as PoseResult;
  } catch (e) {
    console.error("AI service (pose) tidak terjangkau:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface BaselineFeatureRow {
  heart_rate: number;
  oxygen_level: number;
  temperature: number;
  acceleration_magnitude: number;
  gyro_magnitude: number;
  heart_rate_variability: number;
}

export interface PolaNormal {
  median: BaselineFeatureRow;
  skala: BaselineFeatureRow;
  z_threshold: number;
  n: number;
}

/** Latih baseline satu lansia dari riwayat pembacaan. Mengembalikan null bila AI mati / data ditolak. */
export async function trainBaseline(readings: BaselineFeatureRow[]): Promise<{ pola_normal: PolaNormal; versi_model: string } | null> {
  if (!BASE) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(TIMEOUT_MS, 15000));
  try {
    const res = await fetch(`${BASE}/baseline/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readings }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error("AI /baseline/train", res.status, await res.text().catch(() => ""));
      return null;
    }
    return (await res.json()) as { pola_normal: PolaNormal; versi_model: string };
  } catch (e) {
    console.error("AI service (baseline) tidak terjangkau:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
