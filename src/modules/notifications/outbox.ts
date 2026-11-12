import prisma from "../../lib/prisma";
import { type PushPayload, sendPushToUser } from "../../integrations/push";

/**
 * Outbox notifikasi.
 *
 * Alert dan semua baris tb_notifikasi (dashboard + push) dibuat berstatus `pending` dalam SATU transaksi
 * (lihat raiseAlert di alert.engine). Di sini pengirim memprosesnya:
 *  - dashboard: langsung `terkirim` (daftar notifikasi dibaca dari tabel ini).
 *  - push: dikirim lewat FCM. Hasil `ok` -> `terkirim`; `error` (gangguan sementara) -> diulang di putaran berikutnya
 *    sampai MAX_ATTEMPTS lalu `gagal`; `invalid` (token mati) dan kondisi permanen (FCM nonaktif, tidak ada perangkat)
 *    -> `gagal` tanpa diulang.
 * `percobaan_ke` diisi saat baris diklaim, `error_pesan` berisi alasan kegagalan terakhir.
 *
 * Jarak antar percobaan = OUTBOX_INTERVAL_SEC (default 30 dtk). Pengiriman bersifat at-least-once.
 */

export const MAX_ATTEMPTS = 3;
const INTERVAL_SEC = Math.max(1, Number(process.env.OUTBOX_INTERVAL_SEC ?? 30));
const BATCH = 50;

const row = {
  include: { alert: { include: { lansia: { select: { id: true, nama: true } } } } },
} as const;

type PendingRow = Awaited<ReturnType<typeof loadPending>>[number];

function loadPending(limit: number) {
  return prisma.notification.findMany({
    where: { status: "pending", percobaanKe: { lt: MAX_ATTEMPTS } },
    orderBy: { id: "asc" },
    take: limit,
    ...row,
  });
}

export function buildPayload(n: Pick<PendingRow, "alert">): PushPayload {
  const { alert } = n;
  const jenis = alert.jenisAnomali;
  return {
    title: alert.tingkatKeparahan === "tinggi" ? `Peringatan: ${jenis}` : jenis,
    body: `${jenis} pada ${alert.lansia.nama}`,
    data: {
      alertId: String(alert.id),
      elderId: String(alert.idLansia),
      level: alert.tingkatKeparahan,
      type: jenis,
    },
  };
}

type Outcome = "sent" | "failed" | "retry" | "skipped";

async function finish(id: bigint, status: "terkirim" | "gagal" | "pending", errorPesan: string | null) {
  await prisma.notification.update({
    where: { id },
    data: { status, errorPesan, waktuKirim: status === "terkirim" ? new Date() : undefined },
  });
}

async function processOne(n: PendingRow): Promise<Outcome> {
  const attempt = n.percobaanKe + 1;

  // Klaim percobaan ini; bila baris sudah diambil proses lain, lewati.
  const claim = await prisma.notification.updateMany({
    where: { id: n.id, status: "pending", percobaanKe: n.percobaanKe },
    data: { percobaanKe: attempt },
  });
  if (claim.count === 0) return "skipped";

  if (n.channel === "dashboard") {
    await finish(n.id, "terkirim", null);
    return "sent";
  }

  if (n.channel !== "push") {
    await finish(n.id, "gagal", `Kanal ${n.channel} belum didukung`);
    return "failed";
  }

  const r = await sendPushToUser(n.idUserPenerima, buildPayload(n));

  if (!r.enabled) {
    await finish(n.id, "gagal", "Push nonaktif: kunci Firebase (FCM) belum dikonfigurasi di backend");
    return "failed";
  }
  if (r.tokens === 0) {
    await finish(n.id, "gagal", "Tidak ada perangkat terdaftar untuk user ini");
    return "failed";
  }
  if (r.ok > 0) {
    await finish(n.id, "terkirim", null);
    return "sent";
  }
  if (r.error > 0) {
    const msg = `Percobaan ${attempt}/${MAX_ATTEMPTS} gagal: ${r.detail ?? "gangguan FCM"}`;
    if (attempt >= MAX_ATTEMPTS) {
      await finish(n.id, "gagal", msg);
      return "failed";
    }
    await finish(n.id, "pending", msg);
    return "retry";
  }
  // Semua token tidak valid (sudah dihapus): mengulang tidak ada gunanya.
  await finish(n.id, "gagal", "Semua token perangkat tidak valid dan sudah dihapus");
  return "failed";
}

/** Proses satu gelombang baris `pending`. */
export async function dispatchPending(limit = BATCH) {
  const stats = { processed: 0, sent: 0, failed: 0, retry: 0, skipped: 0 };
  const rows = await loadPending(limit);
  for (const n of rows) {
    try {
      const o = await processOne(n);
      stats.processed++;
      stats[o]++;
    } catch (e) {
      // Kegagalan tak terduga (mis. database): baris tetap pending dan dicoba lagi di putaran berikutnya.
      console.error(`[outbox] notifikasi ${n.id} gagal diproses:`, (e as Error).message);
    }
  }
  return stats;
}

let running = false;
let again = false;

/** Jalankan pengirim; bila sedang berjalan, minta satu putaran lagi setelahnya. */
export async function runOutbox() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await dispatchPending();
    } while (again);
  } finally {
    running = false;
  }
}

/** Dipanggil setelah transaksi alert selesai agar notifikasi tidak menunggu putaran berkala. */
export function kickOutbox() {
  void runOutbox().catch((e) => console.error("[outbox]", (e as Error).message));
}

/** Putaran berkala: mengulang percobaan yang gagal sementara dan memulihkan baris `pending` setelah restart. */
export function startNotificationOutbox() {
  kickOutbox();
  setInterval(kickOutbox, INTERVAL_SEC * 1000).unref();
  console.log(`[outbox] pengirim notifikasi aktif: putaran tiap ${INTERVAL_SEC} dtk, maks ${MAX_ATTEMPTS} percobaan`);
}
