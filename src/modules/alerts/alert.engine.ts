import prisma from "../../lib/prisma";
import { publish } from "../../common/events";
import { inferSensor } from "../../integrations/aiClient";
import { latestBaseline } from "../baseline/baseline.service";
import { kickOutbox } from "../notifications/outbox";

// Ambang bisa diubah lewat env tanpa menyentuh kode.
const HR_HIGH = Number(process.env.ALERT_HR_HIGH ?? 120);
const HR_LOW = Number(process.env.ALERT_HR_LOW ?? 45);
const HR_CRIT_HIGH = Number(process.env.ALERT_HR_CRIT_HIGH ?? 140);
const HR_CRIT_LOW = Number(process.env.ALERT_HR_CRIT_LOW ?? 40);
const CONSECUTIVE = Number(process.env.ALERT_CONSECUTIVE ?? 3);
const COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN ?? 30);

const ORDER = { rendah: 0, sedang: 1, tinggi: 2 } as const;
type Level = keyof typeof ORDER;

/**
 * Aturan sederhana (tanpa AI): detak jantung di luar ambang pada N pembacaan terakhir berturut-turut.
 * Dedup + cooldown lewat dedupKey per jendela COOLDOWN_MIN menit (kolom unik di tb_alert).
 */
const WEARABLE_FALL_ALERTS = process.env.WEARABLE_FALL_ALERTS === "true";

export async function evaluateWearable(idWearable: number, idLansia: number) {
  const last = await prisma.vitalSign.findMany({
    where: { idWearable, detakJantung: { not: null } },
    orderBy: { timestamp: "desc" },
    take: CONSECUTIVE,
  });
  if (last.length < CONSECUTIVE) return null;
  const hr = last.map((v) => v.detakJantung as number);

  let jenis: string | null = null;
  let severity: Level = "sedang";
  if (hr.every((v) => v > HR_HIGH)) {
    jenis = "Detak jantung terlalu tinggi";
    if (hr.every((v) => v > HR_CRIT_HIGH)) severity = "tinggi";
  } else if (hr.every((v) => v < HR_LOW)) {
    jenis = "Detak jantung terlalu rendah";
    if (hr.every((v) => v < HR_CRIT_LOW)) severity = "tinggi";
  }
  if (!jenis) return null;

  const bucket = Math.floor(Date.now() / (COOLDOWN_MIN * 60_000));
  const dedupKey = `hr:${idLansia}:${jenis === "Detak jantung terlalu tinggi" ? "high" : "low"}:${bucket}`;
  return raiseAlert({ idLansia, jenis, severity, dedupKey });
}

/**
 * Buat alert (dedup + cooldown lewat dedupKey unik) beserta SEMUA baris notifikasi `pending` dalam satu transaksi,
 * lalu picu pengirim (outbox) dan dorong event realtime. Bila dedupKey sudah ada, transaksi dibatalkan dan hasilnya null.
 */
async function raiseAlert(a: { idLansia: number; jenis: string; severity: Level; dedupKey: string; idPrediksi?: bigint; idJatuh?: bigint; idBaseline?: number; fall?: boolean }) {
  const recipients = await planRecipients(a.idLansia, a.severity);

  let alert;
  try {
    alert = await prisma.$transaction(async (tx) => {
      const created = await tx.alert.create({
        data: { idLansia: a.idLansia, jenisAnomali: a.jenis, tingkatKeparahan: a.severity, dedupKey: a.dedupKey, idPrediksi: a.idPrediksi, idJatuh: a.idJatuh, idBaseline: a.idBaseline },
      });
      const rows = recipients.flatMap((r) => [
        ...(r.dashboard ? [{ idAlert: created.id, idUserPenerima: r.userId, channel: "dashboard" as const, status: "pending" as const }] : []),
        ...(r.push ? [{ idAlert: created.id, idUserPenerima: r.userId, channel: "push" as const, status: "pending" as const }] : []),
      ]);
      if (rows.length) await tx.notification.createMany({ data: rows });
      return created;
    });
  } catch (e: any) {
    if (e?.code === "P2002") return null; // sudah ada alert yang sama dalam cooldown
    throw e;
  }
  kickOutbox();
  publish(a.idLansia, "alert", { id: String(alert.id), type: a.jenis, level: a.severity });
  if (a.fall) publish(a.idLansia, "fall", { id: String(alert.id) });
  return alert;
}

const NAMA_FITUR: Record<string, string> = {
  heart_rate: "detak jantung",
  oxygen_level: "saturasi oksigen",
  temperature: "suhu tubuh",
  acceleration_magnitude: "akselerasi",
  gyro_magnitude: "gerak (gyro)",
  heart_rate_variability: "HRV",
};

/**
 * Analisis AI untuk satu pembacaan lengkap (6 metrik): model deteksi jatuh + baseline anomali.
 * Fitur riwayat memakai gyro_magnitude 3 pembacaan sebelumnya milik wearable yang sama (kontrak model).
 * Mengembalikan null bila AI tidak aktif/tidak terjangkau atau hasilnya NORMAL.
 */
export async function evaluateSensor(idWearable: number, idLansia: number, at: Date) {
  const cur = await prisma.wearableData.findUnique({ where: { idWearable_timestamp: { idWearable, timestamp: at } } });
  if (
    !cur ||
    cur.detakJantung === null || cur.oxygenLevel === null || cur.temperature === null ||
    cur.accelerationMagnitude === null || cur.gyroMagnitude === null || cur.heartRateVariability === null ||
    cur.accelerationMagnitude <= 0
  ) return null;

  const prev = await prisma.wearableData.findMany({
    where: { idWearable, timestamp: { lt: at }, gyroMagnitude: { not: null } },
    orderBy: { timestamp: "desc" },
    take: 3,
    select: { gyroMagnitude: true },
  });
  const riwayat = prev.map((p) => p.gyroMagnitude as number).reverse(); // lama -> baru

  // Baseline per lansia (bila sudah terbentuk); tanpa itu AI memakai baseline umum (cold start).
  const baseline = await latestBaseline(idLansia);

  const r = await inferSensor({
    heart_rate: cur.detakJantung,
    oxygen_level: cur.oxygenLevel,
    temperature: cur.temperature,
    acceleration_magnitude: cur.accelerationMagnitude,
    gyro_magnitude: cur.gyroMagnitude,
    heart_rate_variability: cur.heartRateVariability,
    riwayat_gyro_magnitude: riwayat,
    pola_normal: baseline?.polaNormal,
  });
  if (!r || r.status === "NORMAL") return null;

  // Jatuh ditentukan KAMERA (CCTV). Jam pintar hanya mengumpulkan data dan membangun baseline anomali,
  // jadi label JATUH dari sensor tidak membuat alert kecuali WEARABLE_FALL_ALERTS=true.
  const jatuh = r.status === "JATUH";
  if (jatuh && !WEARABLE_FALL_ALERTS) return null;
  const severity: Level = jatuh ? "tinggi" : "sedang";
  const pred = await prisma.riskPrediction.create({
    data: { idLansia, skorRisiko: r.peluang_jatuh, levelRisiko: severity, idBaseline: r.baseline === "lansia" ? baseline?.id : undefined },
  });
  if (jatuh) return raiseFall({ idLansia, jenis: "Jatuh terdeteksi (sensor)", idPrediksi: pred.id });

  const personal = r.baseline === "lansia";
  const bucket = Math.floor(Date.now() / (COOLDOWN_MIN * 60_000));
  return raiseAlert({
    idLansia,
    jenis: `Anomali tanda vital: ${NAMA_FITUR[r.fitur_penyebab] ?? r.fitur_penyebab}${personal ? " (di luar pola normal lansia)" : ""}`,
    severity,
    // Per jenis anomali: demam tidak boleh tertahan oleh alert detak jantung yang baru muncul.
    dedupKey: `ai:${idLansia}:anomali:${r.fitur_penyebab}:${bucket}`,
    idPrediksi: pred.id,
    idBaseline: personal ? baseline?.id : undefined,
  });
}

/**
 * Jatuh (dari sensor ATAU kamera): satu kejadian + satu alert per jendela cooldown.
 * Dedup dipakai bersama, jadi sensor dan kamera yang mendeteksi jatuh yang sama tidak menggandakan alert.
 * Kejadian dibuat agar keluarga bisa mengonfirmasi benar/alarm palsu (data evaluasi NFR-07).
 */
export async function raiseFall(a: { idLansia: number; jenis: string; idDeteksi?: bigint; idPrediksi?: bigint }) {
  const since = new Date(Date.now() - COOLDOWN_MIN * 60_000);
  const recent = await prisma.fallEvent.findFirst({ where: { idLansia: a.idLansia, waktuKejadian: { gte: since } } });
  if (recent) return null; // jatuh yang sama sudah dilaporkan dalam cooldown

  const fall = await prisma.fallEvent.create({ data: { idLansia: a.idLansia, idDeteksi: a.idDeteksi } });
  const bucket = Math.floor(Date.now() / (COOLDOWN_MIN * 60_000));
  return raiseAlert({
    idLansia: a.idLansia,
    jenis: a.jenis,
    severity: "tinggi",
    dedupKey: `fall:${a.idLansia}:${bucket}`,
    idPrediksi: a.idPrediksi,
    idJatuh: fall.id,
    fall: true,
  });
}

export interface Recipient {
  userId: number;
  dashboard: boolean;
  push: boolean;
}

/**
 * Penerima: keluarga pemilik + tenaga medis berizin aktif, disaring dengan level minimum tiap user.
 * Kanal dashboard (baris di tb_notifikasi) dan push (FCM) diatur terpisah oleh preferensi masing-masing user.
 * WhatsApp/email belum diimplementasi.
 */
export async function planRecipients(idLansia: number, severity: Level): Promise<Recipient[]> {
  const lansia = await prisma.lansia.findUnique({ where: { id: idLansia }, select: { idUserKeluarga: true, nama: true } });
  if (!lansia) return [];
  const now = new Date();
  const grants = await prisma.accessGrant.findMany({
    where: { idLansia, status: "aktif", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { idUserMedis: true },
  });
  const userIds = [...new Set([lansia.idUserKeluarga, ...grants.map((g) => g.idUserMedis)])];
  const prefs = await prisma.notificationPreference.findMany({ where: { idUser: { in: userIds } } });
  const prefBy = new Map(prefs.map((p) => [p.idUser, p]));

  // Hanya user yang level minimumnya terpenuhi yang diberi tahu (lewat kanal apa pun).
  return userIds
    .filter((id) => {
      const min = (prefBy.get(id)?.levelMinimum ?? "sedang") as Level;
      return ORDER[severity] >= (ORDER[min] ?? 1);
    })
    .map((id) => ({ userId: id, dashboard: prefBy.get(id)?.dashboard ?? true, push: prefBy.get(id)?.push ?? true }));
}
