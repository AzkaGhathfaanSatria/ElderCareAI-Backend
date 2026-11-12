import prisma from "../../lib/prisma";

/**
 * Riwayat kondisi lansia per periode (tb_riwayat_kondisi).
 *
 * Pencatat berjalan tiap RIWAYAT_INTERVAL_MIN menit (default 5). Tiap tick ia merangkum periode yang baru selesai
 * untuk setiap lansia yang punya perangkat: data jam, risiko model, deteksi kamera, dan peringatan.
 * Tabel diakses lewat SQL berparameter (bukan klien Prisma ter-generate) supaya tidak bergantung pada `prisma generate`.
 */

export const INTERVAL_MIN = Math.max(1, Number(process.env.RIWAYAT_INTERVAL_MIN ?? 5));
const RETENTION_DAYS = Number(process.env.RIWAYAT_RETENTION_DAYS ?? 90);
// Jam mengirim data tiap 15 menit atau lebih. Bila periode belum punya data baru, pembacaan terakhir dalam rentang ini dipakai.
const STALE_MIN = Number(process.env.RIWAYAT_STALE_MIN ?? 45);

const HR_HIGH = Number(process.env.ALERT_HR_HIGH ?? 120);
const HR_LOW = Number(process.env.ALERT_HR_LOW ?? 45);
const HR_CRIT_HIGH = Number(process.env.ALERT_HR_CRIT_HIGH ?? 140);
const HR_CRIT_LOW = Number(process.env.ALERT_HR_CRIT_LOW ?? 40);
const SPO2_LOW = Number(process.env.RIWAYAT_SPO2_LOW ?? 94);
const SPO2_CRIT = Number(process.env.RIWAYAT_SPO2_CRIT ?? 90);
const TEMP_HIGH = Number(process.env.RIWAYAT_TEMP_HIGH ?? 37.8);

export type KondisiStatus = "aman" | "waspada" | "bahaya" | "tidak_ada_data";

type WearRow = {
  n: number;
  hr: number | null;
  hr_min: number | null;
  hr_max: number | null;
  spo2: number | null;
  suhu: number | null;
  hrv: number | null;
  last_at: Date | null;
};

export type Ringkasan = {
  status: KondisiStatus;
  dataJamAda: boolean;
  detakRata: number | null;
  detakMin: number | null;
  detakMaks: number | null;
  spo2Rata: number | null;
  suhuRata: number | null;
  hrvRata: number | null;
  skorRisiko: number | null;
  levelRisiko: string | null;
  deteksiKamera: number;
  jatuhTerdeteksi: boolean;
  jumlahAlert: number;
  ringkasan: string;
};

const round = (v: number | null, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Ringkas satu lansia untuk periode [mulai, akhir). */
export async function ringkasPeriode(idLansia: number, mulai: Date, akhir: Date): Promise<Ringkasan> {
  const [wear] = await prisma.$queryRaw<WearRow[]>`
    SELECT count(*)::int AS n,
           avg(wd.detak_jantung)::float8 AS hr, min(wd.detak_jantung)::int AS hr_min, max(wd.detak_jantung)::int AS hr_max,
           avg(wd.oxygen_level)::float8 AS spo2, avg(wd.temperature)::float8 AS suhu,
           avg(wd.heart_rate_variability)::float8 AS hrv, max(wd.timestamp) AS last_at
    FROM tb_data_wearable wd JOIN tb_wearable w ON w.id_wearable = wd.id_wearable
    WHERE w.id_lansia = ${idLansia} AND wd.timestamp >= ${mulai}::timestamptz AND wd.timestamp < ${akhir}::timestamptz`;

  let w = wear;
  let usedStale = false;
  let staleAgeMin = 0;
  if (!w || w.n === 0) {
    const batas = new Date(akhir.getTime() - STALE_MIN * 60_000);
    const [last] = await prisma.$queryRaw<WearRow[]>`
      SELECT 1 AS n, wd.detak_jantung::float8 AS hr, wd.detak_jantung::int AS hr_min, wd.detak_jantung::int AS hr_max,
             wd.oxygen_level::float8 AS spo2, wd.temperature::float8 AS suhu,
             wd.heart_rate_variability::float8 AS hrv, wd.timestamp AS last_at
      FROM tb_data_wearable wd JOIN tb_wearable w ON w.id_wearable = wd.id_wearable
      WHERE w.id_lansia = ${idLansia} AND wd.timestamp >= ${batas}::timestamptz AND wd.timestamp < ${akhir}::timestamptz
      ORDER BY wd.timestamp DESC LIMIT 1`;
    if (last) {
      w = last;
      usedStale = true;
      staleAgeMin = Math.round((akhir.getTime() - new Date(last.last_at as Date).getTime()) / 60_000);
    }
  }
  const dataJamAda = Boolean(w && w.n > 0);

  const [risk] = await prisma.$queryRaw<{ skor: number; level: string }[]>`
    SELECT skor_risiko::float8 AS skor, level_risiko AS level FROM tb_prediksi_risiko_jatuh
    WHERE id_lansia = ${idLansia} AND waktu_prediksi >= ${mulai}::timestamptz AND waktu_prediksi < ${akhir}::timestamptz
    ORDER BY waktu_prediksi DESC LIMIT 1`;

  const [cam] = await prisma.$queryRaw<{ total: number; jatuh: number }[]>`
    SELECT count(*)::int AS total, (count(*) FILTER (WHERE lower(kelas) = 'fall'))::int AS jatuh
    FROM tb_deteksi_yolo WHERE id_lansia = ${idLansia} AND timestamp >= ${mulai}::timestamptz AND timestamp < ${akhir}::timestamptz`;
  const [fall] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM tb_kejadian_jatuh
    WHERE id_lansia = ${idLansia} AND waktu_kejadian >= ${mulai}::timestamptz AND waktu_kejadian < ${akhir}::timestamptz`;
  const [alerts] = await prisma.$queryRaw<{ total: number; tinggi: number }[]>`
    SELECT count(*)::int AS total, (count(*) FILTER (WHERE tingkat_keparahan::text = 'tinggi'))::int AS tinggi
    FROM tb_alert WHERE id_lansia = ${idLansia} AND waktu_deteksi >= ${mulai}::timestamptz AND waktu_deteksi < ${akhir}::timestamptz`;

  const hr = w?.hr ?? null;
  const spo2 = w?.spo2 ?? null;
  const suhu = w?.suhu ?? null;
  const jatuh = (cam?.jatuh ?? 0) > 0 || (fall?.n ?? 0) > 0;
  const deteksi = cam?.total ?? 0;
  const jumlahAlert = alerts?.total ?? 0;
  const levelRisiko = risk?.level ?? null;

  const masalah: string[] = [];
  let status: KondisiStatus;
  const bahaya =
    jatuh ||
    (alerts?.tinggi ?? 0) > 0 ||
    (hr !== null && (hr >= HR_CRIT_HIGH || hr <= HR_CRIT_LOW)) ||
    (spo2 !== null && spo2 < SPO2_CRIT);
  const waspada =
    jumlahAlert > 0 ||
    (hr !== null && (hr > HR_HIGH || hr < HR_LOW)) ||
    (spo2 !== null && spo2 < SPO2_LOW) ||
    (suhu !== null && suhu >= TEMP_HIGH) ||
    (levelRisiko !== null && levelRisiko.toLowerCase() === "tinggi");

  if (jatuh) masalah.push("jatuh terdeteksi kamera");
  if (hr !== null && (hr >= HR_CRIT_HIGH || hr <= HR_CRIT_LOW)) masalah.push(`detak jantung kritis (${Math.round(hr)} bpm)`);
  else if (hr !== null && (hr > HR_HIGH || hr < HR_LOW)) masalah.push(`detak jantung di luar batas (${Math.round(hr)} bpm)`);
  if (spo2 !== null && spo2 < SPO2_LOW) masalah.push(`oksigen rendah (${round(spo2)}%)`);
  if (suhu !== null && suhu >= TEMP_HIGH) masalah.push(`suhu tinggi (${round(suhu)}°C)`);
  if (jumlahAlert > 0) masalah.push(`${jumlahAlert} peringatan`);

  if (!dataJamAda && deteksi === 0 && jumlahAlert === 0) status = "tidak_ada_data";
  else if (bahaya) status = "bahaya";
  else if (waspada) status = "waspada";
  else status = "aman";

  const bagian: string[] = [];
  if (status === "tidak_ada_data") bagian.push("Belum ada data dari jam maupun kamera.");
  else {
    if (masalah.length) bagian.push(masalah[0].charAt(0).toUpperCase() + masalah.join(", ").slice(1) + ".");
    else bagian.push(`Kondisi normal${hr !== null ? `, detak jantung ${Math.round(hr)} bpm` : ""}${jatuh ? "" : ", tidak ada jatuh"}.`);
    if (!dataJamAda) bagian.push("Data jam belum masuk.");
    else if (usedStale) bagian.push(`Memakai data jam terakhir (${staleAgeMin} menit lalu).`);
  }

  return {
    status,
    dataJamAda,
    detakRata: round(hr),
    detakMin: w?.hr_min ?? null,
    detakMaks: w?.hr_max ?? null,
    spo2Rata: round(spo2),
    suhuRata: round(suhu),
    hrvRata: round(w?.hrv ?? null),
    skorRisiko: risk?.skor ?? null,
    levelRisiko,
    deteksiKamera: deteksi,
    jatuhTerdeteksi: jatuh,
    jumlahAlert,
    ringkasan: bagian.join(" "),
  };
}

/** Catat satu periode untuk semua lansia yang punya perangkat. Idempoten (unik per lansia + waktu). */
export async function catatPeriode(akhir: Date) {
  const mulai = new Date(akhir.getTime() - INTERVAL_MIN * 60_000);
  const elders = await prisma.$queryRaw<{ id: number }[]>`
    SELECT l.id_lansia::int AS id FROM tb_lansia l
    WHERE EXISTS (SELECT 1 FROM tb_wearable w WHERE w.id_lansia = l.id_lansia)
       OR EXISTS (SELECT 1 FROM tb_kamera_cctv k WHERE k.id_lansia = l.id_lansia)`;
  let dicatat = 0;
  for (const { id } of elders) {
    try {
      const r = await ringkasPeriode(id, mulai, akhir);
      const n = await prisma.$executeRaw`
        INSERT INTO tb_riwayat_kondisi
          (id_lansia, waktu, periode_menit, status, data_jam_ada, detak_rata, detak_min, detak_maks, spo2_rata, suhu_rata,
           hrv_rata, skor_risiko, level_risiko, deteksi_kamera, jatuh_terdeteksi, jumlah_alert, ringkasan)
        VALUES (${id}, ${akhir}::timestamptz, ${INTERVAL_MIN}, ${r.status}, ${r.dataJamAda}, ${r.detakRata}, ${r.detakMin}, ${r.detakMaks},
                ${r.spo2Rata}, ${r.suhuRata}, ${r.hrvRata}, ${r.skorRisiko}, ${r.levelRisiko}, ${r.deteksiKamera},
                ${r.jatuhTerdeteksi}, ${r.jumlahAlert}, ${r.ringkasan})
        ON CONFLICT (id_lansia, waktu) DO NOTHING`;
      dicatat += n;
    } catch (e) {
      console.error(`[riwayat] lansia ${id} gagal:`, (e as Error).message);
    }
  }
  return dicatat;
}

/** Batas periode yang baru selesai: waktu sekarang dibulatkan ke bawah per interval. */
export function akhirPeriode(now = new Date()) {
  const ms = INTERVAL_MIN * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export async function bersihkanRiwayatLama() {
  const batas = new Date(Date.now() - RETENTION_DAYS * 86400_000);
  return prisma.$executeRaw`DELETE FROM tb_riwayat_kondisi WHERE waktu < ${batas}::timestamptz`;
}

/** Jalankan pencatat sejajar batas interval (mis. 10:00, 10:05, ...), plus pembersihan harian. */
export function startRiwayatScheduler() {
  if (process.env.RIWAYAT_ENABLED === "false") return;
  const ms = INTERVAL_MIN * 60_000;

  const tick = async () => {
    try {
      const n = await catatPeriode(akhirPeriode());
      if (n > 0) console.log(`[riwayat] ${n} lansia dicatat`);
    } catch (e) {
      console.error("[riwayat] pencatat gagal:", (e as Error).message);
    }
  };
  const bersih = async () => {
    try {
      const n = await bersihkanRiwayatLama();
      if (n > 0) console.log(`[riwayat] ${n} baris lama dihapus`);
    } catch (e) {
      console.error("[riwayat] pembersihan gagal:", (e as Error).message);
    }
  };

  // Tunggu 5 dtk setelah batas interval supaya data terakhir periode itu sudah masuk.
  const tunggu = ms - (Date.now() % ms) + 5_000;
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), ms).unref();
  }, tunggu).unref();
  setTimeout(() => void bersih(), 60_000).unref();
  setInterval(() => void bersih(), 24 * 3600_000).unref();
  console.log(`[riwayat] pencatat aktif: tiap ${INTERVAL_MIN} menit, simpan ${RETENTION_DAYS} hari`);
}

export type RiwayatRow = {
  id: number;
  waktu: Date;
  periode_menit: number;
  status: KondisiStatus;
  data_jam_ada: boolean;
  detak_rata: number | null;
  detak_min: number | null;
  detak_maks: number | null;
  spo2_rata: number | null;
  suhu_rata: number | null;
  hrv_rata: number | null;
  skor_risiko: number | null;
  level_risiko: string | null;
  deteksi_kamera: number;
  jatuh_terdeteksi: boolean;
  jumlah_alert: number;
  ringkasan: string | null;
};

export async function ambilRiwayat(idLansia: number, dari: Date, limit: number) {
  return prisma.$queryRaw<RiwayatRow[]>`
    SELECT id_riwayat::int AS id, waktu, periode_menit, status, data_jam_ada, detak_rata, detak_min, detak_maks,
           spo2_rata, suhu_rata, hrv_rata, skor_risiko, level_risiko, deteksi_kamera, jatuh_terdeteksi, jumlah_alert, ringkasan
    FROM tb_riwayat_kondisi
    WHERE id_lansia = ${idLansia} AND waktu >= ${dari}::timestamptz
    ORDER BY waktu DESC LIMIT ${limit}`;
}
