/**
 * Simulator wearable: mengirim data palsu ke POST /ingest/wearable supaya dashboard terisi.
 *
 * Contoh:
 *   npm run simulate -- --key ecw_xxx --backfill 7        # isi riwayat 7 hari lalu berhenti
 *   npm run simulate -- --key ecw_xxx                      # kirim data live tiap 10 detik
 *   npm run simulate -- --key ecw_xxx --anomaly            # sesekali detak jantung tinggi (memicu alert aturan ambang)
 *   npm run simulate -- --key ecw_xxx --fall               # sesekali pola jatuh (HR tinggi, SpO2 turun, gyro besar) -> dinilai model AI
 *
 * Tiap pembacaan membawa 6 metrik sesuai kontrak model AI: heartRate, oxygenLevel, temperature,
 * accelerationMagnitude, gyroMagnitude, heartRateVariability. Rentang normal mengikuti baseline model.
 *
 * Opsi: --url (default http://localhost:4000)  --interval detik (default 10)  --backfill hari  --anomaly
 * Key juga bisa lewat env DEVICE_KEY.
 */
const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name: string) => args.includes(`--${name}`);

const url = opt("url", "http://localhost:4000")!;
const key = opt("key", process.env.DEVICE_KEY);
const interval = Number(opt("interval", "10"));
const backfillDays = Number(opt("backfill", "0"));
const anomaly = flag("anomaly");
const fall = flag("fall");

if (!key) {
  console.error("Device key wajib: --key ecw_xxx (didapat saat mendaftarkan wearable di halaman Perangkat)");
  process.exit(1);
}

interface Reading {
  timestamp: string; heartRate?: number; sleepHours?: number; battery?: number; moving?: boolean;
  oxygenLevel?: number; temperature?: number; accelerationMagnitude?: number; gyroMagnitude?: number; heartRateVariability?: number;
}

let hr = 72;
let battery = 100;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
function nextHr(asleep: boolean) {
  const target = asleep ? 58 : 76;
  hr += (target - hr) * 0.2 + rand(-3, 3);
  return Math.round(Math.min(110, Math.max(48, hr)));
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Metrik normal (median baseline: SpO2 98, suhu 36.8, acc ~9.96, gyro ~0.16, HRV ~41). */
function normalMetrics(asleep: boolean, moving: boolean): Partial<Reading> {
  return {
    oxygenLevel: r2(rand(97.3, 98.8)),
    temperature: r2(rand(36.7, 36.95)),
    accelerationMagnitude: r2(moving ? rand(9.9, 10.3) : rand(9.85, 10.05)),
    gyroMagnitude: r2(asleep ? rand(0.05, 0.12) : moving ? rand(0.15, 0.3) : rand(0.08, 0.2)),
    heartRateVariability: r2(asleep ? rand(43, 50) : rand(38, 44)),
  };
}

/** Pola jatuh (mirip kasus uji notebook: HR ~134, SpO2 ~86, acc ~5.9, gyro ~3.1, HRV ~15). */
function fallMetrics(): Partial<Reading> {
  return {
    heartRate: Math.round(rand(128, 140)),
    oxygenLevel: r2(rand(84, 88)),
    temperature: r2(rand(36.8, 37.0)),
    accelerationMagnitude: r2(rand(5.6, 6.2)),
    gyroMagnitude: r2(rand(2.9, 3.4)),
    heartRateVariability: r2(rand(13, 18)),
  };
}

async function send(readings: Reading[]) {
  const res = await fetch(`${url}/ingest/wearable`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Key": key! },
    body: JSON.stringify({ readings }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body as { accepted: number; duplicates: number; rejected: number };
}

async function backfill(days: number) {
  const now = Date.now();
  const all: Reading[] = [];
  const slot = 30 * 60_000;
  // Timestamp dibulatkan ke kelipatan 30 menit supaya menjalankan ulang backfill tidak menggandakan data.
  for (let t = Math.floor((now - days * 86400_000) / slot) * slot; t < now; t += slot) {
    const d = new Date(t);
    const hour = (d.getUTCHours() + 7) % 24; // WIB
    const asleep = hour >= 22 || hour < 5;
    const moving = !asleep && Math.random() < 0.6;
    const r: Reading = { timestamp: d.toISOString(), heartRate: nextHr(asleep), moving, ...normalMetrics(asleep, moving) };
    if (hour === 6 && d.getUTCMinutes() === 0) r.sleepHours = Math.round(rand(5, 8.2) * 10) / 10;
    all.push(r);
  }
  let accepted = 0, duplicates = 0;
  for (let i = 0; i < all.length; i += 200) {
    const r = await send(all.slice(i, i + 200));
    accepted += r.accepted; duplicates += r.duplicates;
  }
  console.log(`Backfill ${days} hari: ${accepted} data baru, ${duplicates} duplikat (aman dijalankan ulang)`);
}

async function live() {
  console.log(`Mengirim data live tiap ${interval} detik ke ${url} ${anomaly ? "(mode anomali aktif)" : ""}${fall ? "(mode jatuh aktif)" : ""} - Ctrl+C untuk berhenti`);
  let tick = 0;
  let spikeLeft = 0;
  for (;;) {
    tick++;
    if (anomaly && spikeLeft === 0 && tick % 12 === 0) spikeLeft = 4;
    const doFall = fall && (tick === 4 || (tick > 4 && (tick - 4) % 20 === 0)); // jatuh ke-1 di tick 4, lalu tiap 20 tick
    battery = Math.max(5, battery - 0.05);
    const spike = spikeLeft > 0;
    const heartRate = spike ? Math.round(rand(145, 165)) : nextHr(false);
    if (spike) spikeLeft--;
    try {
      const moving = Math.random() < 0.6;
      const reading: Reading = { timestamp: new Date().toISOString(), heartRate, battery: Math.round(battery), moving, ...normalMetrics(false, moving), ...(doFall ? fallMetrics() : {}) };
      const r = await send([reading]);
      console.log(`${new Date().toLocaleTimeString()}  HR ${reading.heartRate}  SpO2 ${reading.oxygenLevel}${spike ? "  <-- anomali HR" : ""}${doFall ? "  <-- POLA JATUH" : ""}  (diterima ${r.accepted})`);
    } catch (e) {
      console.error("Gagal kirim:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

(async () => {
  if (backfillDays > 0) {
    await backfill(backfillDays);
    if (!args.includes("--interval") && !anomaly && !fall) return; // hanya backfill
  }
  await live();
})();
