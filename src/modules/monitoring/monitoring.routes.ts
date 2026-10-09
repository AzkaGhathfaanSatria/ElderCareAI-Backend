import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { authenticate, AuthRequest } from "../../common/middleware/auth.middleware";

/**
 * Route monitoring: lansia, perangkat, notifikasi, profil (/me).
 * Bentuk respons disesuaikan dengan normalizer di frontend (backendApi.ts).
 */
const router = Router();
router.use(authenticate);

// ---------- helper ----------

const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const TZ = "Asia/Jakarta";

function accessibleElderWhere(user: NonNullable<AuthRequest["user"]>) {
  if (user.role === "admin") return {};
  if (user.role === "keluarga") return { idUserKeluarga: user.userId };
  return { izinAkses: { some: { idUserMedis: user.userId, status: "aktif" } } };
}

async function findElder(req: AuthRequest, idParam: unknown) {
  const id = Number(idParam);
  if (!Number.isInteger(id)) return null;
  return prisma.lansia.findFirst({
    where: { id, ...accessibleElderWhere(req.user!) },
  });
}

function calcAge(date: Date) {
  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const m = now.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < date.getDate())) age -= 1;
  return age;
}

function elderDto(l: {
  id: number;
  nama: string;
  tanggalLahir: Date;
  alamat: string;
  catatanKesehatan: string | null;
}) {
  return {
    id: String(l.id),
    nama: l.nama,
    tanggalLahir: l.tanggalLahir.toISOString().slice(0, 10),
    umur: calcAge(l.tanggalLahir),
    alamat: l.alamat,
    catatanKesehatan: l.catatanKesehatan ?? "",
    monitoringStatus: "Aktif",
  };
}

function levelLabel(value?: string | null): "Rendah" | "Sedang" | "Tinggi" {
  const v = (value ?? "").toLowerCase();
  if (v === "tinggi" || v === "high") return "Tinggi";
  if (v === "sedang" || v === "medium") return "Sedang";
  return "Rendah";
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric", timeZone: TZ });
}

function fmtTime(d: Date) {
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).replace(".", ":");
}

function dayLabel(d: Date) {
  const idx = new Date(d.toLocaleString("en-US", { timeZone: TZ })).getDay();
  return HARI[idx] ?? "";
}

function sleepHours(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const k of ["jam", "hours", "durasi", "durasiJam", "total", "totalJam", "totalHours"]) {
      if (typeof o[k] === "number") return o[k] as number;
    }
    for (const k of ["menit", "minutes", "durasiMenit"]) {
      if (typeof o[k] === "number") return Math.round(((o[k] as number) / 60) * 10) / 10;
    }
  }
  return 0;
}

function fail(res: Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ success: false, message: "Data tidak valid", errors: error.issues });
  }
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback });
}

// ---------- /me ----------

router.get("/me", async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, nama: true, email: true, noTelepon: true, role: true },
    });
    if (!user) return res.status(404).json({ success: false, message: "User tidak ditemukan" });
    return res.json({ user });
  } catch (e) {
    return fail(res, e, "Gagal mengambil profil");
  }
});

router.patch("/me", async (req: AuthRequest, res) => {
  try {
    const body = z
      .object({
        name: z.string().min(2).max(100).optional(),
        nama: z.string().min(2).max(100).optional(),
        email: z.string().email().max(150).optional(),
      })
      .parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { nama: body.nama ?? body.name, email: body.email },
      select: { id: true, nama: true, email: true, noTelepon: true, role: true },
    });
    return res.json({ user });
  } catch (e: any) {
    if (e?.code === "P2002") return res.status(400).json({ success: false, message: "Email sudah dipakai" });
    return fail(res, e, "Gagal memperbarui profil");
  }
});

// ---------- lansia ----------

router.get("/elders", async (req: AuthRequest, res) => {
  try {
    const elders = await prisma.lansia.findMany({
      where: accessibleElderWhere(req.user!),
      orderBy: { id: "asc" },
    });
    return res.json({ data: elders.map(elderDto) });
  } catch (e) {
    return fail(res, e, "Gagal mengambil data lansia");
  }
});

router.post("/elders", async (req: AuthRequest, res) => {
  try {
    if (req.user!.role === "tenaga_medis") {
      return res.status(403).json({ success: false, message: "Tenaga medis tidak dapat mendaftarkan lansia" });
    }
    const raw = z
      .object({
        name: z.string().optional(),
        nama: z.string().optional(),
        birthDate: z.string().optional(),
        tanggal_lahir: z.string().optional(),
        address: z.string().optional(),
        alamat: z.string().optional(),
        healthNotes: z.string().optional(),
        catatan_kesehatan: z.string().optional(),
      })
      .parse(req.body);

    const nama = (raw.nama ?? raw.name ?? "").trim();
    const alamat = (raw.alamat ?? raw.address ?? "").trim();
    const tanggal = new Date(raw.tanggal_lahir ?? raw.birthDate ?? "");
    if (nama.length < 2) return res.status(400).json({ success: false, message: "Nama lansia wajib diisi" });
    if (!alamat) return res.status(400).json({ success: false, message: "Alamat wajib diisi" });
    if (Number.isNaN(tanggal.getTime())) return res.status(400).json({ success: false, message: "Tanggal lahir tidak valid" });

    const elder = await prisma.lansia.create({
      data: {
        idUserKeluarga: req.user!.userId,
        nama,
        alamat,
        tanggalLahir: tanggal,
        catatanKesehatan: raw.catatan_kesehatan ?? raw.healthNotes ?? null,
      },
    });
    return res.status(201).json({ elder: elderDto(elder) });
  } catch (e) {
    return fail(res, e, "Gagal mendaftarkan lansia");
  }
});

router.get("/elders/:id/summary", async (req: AuthRequest, res) => {
  try {
    const elder = await findElder(req, req.params.id);
    if (!elder) return res.status(404).json({ success: false, message: "Lansia tidak ditemukan" });

    const wearables = await prisma.wearable.findMany({ where: { idLansia: elder.id }, select: { id: true } });
    const wearableIds = wearables.map((w) => w.id);

    const [vital, vitalWithSleep, latestRisk, latestAlert, activities] = await Promise.all([
      prisma.vitalSign.findFirst({ where: { idWearable: { in: wearableIds } }, orderBy: { timestamp: "desc" } }),
      prisma.vitalSign.findMany({ where: { idWearable: { in: wearableIds } }, orderBy: { timestamp: "desc" }, take: 20 }),
      prisma.riskPrediction.findFirst({ where: { idLansia: elder.id }, orderBy: { waktuPrediksi: "desc" } }),
      prisma.alert.findFirst({
        where: { idLansia: elder.id, status: { not: "selesai" } },
        orderBy: { waktuDeteksi: "desc" },
      }),
      prisma.activity.findMany({
        where: { sensor: { idLansia: elder.id }, timestamp: { gte: new Date(Date.now() - 7 * 86400000) } },
        select: { timestamp: true },
      }),
    ]);

    // Aktivitas 7 hari terakhir: jumlah kejadian sensor per hari, diskalakan ke persen (hari tersibuk = 100%)
    const counts = new Map<string, { label: string; n: number }>();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      counts.set(fmtDate(d), { label: dayLabel(d), n: 0 });
    }
    for (const a of activities) {
      const c = counts.get(fmtDate(a.timestamp));
      if (c) c.n += 1;
    }
    const maxN = Math.max(1, ...[...counts.values()].map((c) => c.n));
    const activityHistory = [...counts.values()].map((c) => ({ day: c.label, value: Math.round((c.n / maxN) * 100) }));
    const today = activityHistory[activityHistory.length - 1]?.value ?? 0;

    const sleepRecord = vitalWithSleep.find((v) => v.polaTidur !== null);
    const risk = latestRisk ? levelLabel(latestRisk.levelRisiko) : latestAlert ? levelLabel(latestAlert.tingkatKeparahan) : "Rendah";

    return res.json({
      heartRate: vital?.detakJantung ?? 0,
      activity: today,
      sleep: sleepRecord ? sleepHours(sleepRecord.polaTidur) : 0,
      risk,
      activityHistory,
      hasAlert: Boolean(latestAlert),
      alert: latestAlert
        ? {
            id: String(latestAlert.id),
            status: latestAlert.status,
            type: latestAlert.jenisAnomali,
            description: latestAlert.jenisAnomali,
            detected: `${fmtDate(latestAlert.waktuDeteksi)} ${fmtTime(latestAlert.waktuDeteksi)} WIB`,
            level: levelLabel(latestAlert.tingkatKeparahan),
          }
        : {},
    });
  } catch (e) {
    return fail(res, e, "Gagal mengambil ringkasan");
  }
});

router.get("/elders/:id/history", async (req: AuthRequest, res) => {
  try {
    const elder = await findElder(req, req.params.id);
    if (!elder) return res.status(404).json({ success: false, message: "Lansia tidak ditemukan" });
    const alerts = await prisma.alert.findMany({
      where: { idLansia: elder.id, waktuDeteksi: { gte: new Date(Date.now() - 90 * 86400000) } },
      orderBy: { waktuDeteksi: "desc" },
      take: 100,
    });
    return res.json({
      items: alerts.map((a) => ({
        id: String(a.id),
        date: fmtDate(a.waktuDeteksi),
        time: fmtTime(a.waktuDeteksi),
        type: a.jenisAnomali,
        description: a.jenisAnomali,
        level: levelLabel(a.tingkatKeparahan),
      })),
    });
  } catch (e) {
    return fail(res, e, "Gagal mengambil riwayat");
  }
});

router.get("/elders/:id/vitals", async (req: AuthRequest, res) => {
  try {
    const elder = await findElder(req, req.params.id);
    if (!elder) return res.status(404).json({ success: false, message: "Lansia tidak ditemukan" });
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const wearables = await prisma.wearable.findMany({ where: { idLansia: elder.id }, select: { id: true } });
    const rows = await prisma.vitalSign.findMany({
      where: { idWearable: { in: wearables.map((w) => w.id) }, timestamp: { gte: from, lte: to } },
      orderBy: { timestamp: "asc" },
      take: 1000,
    });
    return res.json({
      items: rows.map((r) => ({ id: String(r.id), heartRate: r.detakJantung, sleep: r.polaTidur, timestamp: r.timestamp })),
    });
  } catch (e) {
    return fail(res, e, "Gagal mengambil data vital");
  }
});

// Realtime (SSE) belum diimplementasi. 204 membuat EventSource berhenti mencoba menyambung ulang.
router.get("/elders/:id/stream", (_req, res) => {
  res.status(204).end();
});

// ---------- perangkat ----------
// id perangkat diberi prefix agar unik antar tabel: "w-<id>" wearable, "c-<id>" kamera.

function parseDeviceId(raw: string): { kind: "w" | "c"; id: number } | null {
  const m = /^([wc])-(\d+)$/.exec(raw);
  if (!m) return null;
  return { kind: m[1] as "w" | "c", id: Number(m[2]) };
}

const RECENT_MS = 15 * 60 * 1000;

function wearableDto(w: { id: number; idLansia: number; tipePerangkat: string; statusBaterai: number; tanggalPairing: Date; lastSeen: Date | null }, elderName?: string) {
  const online = w.lastSeen ? Date.now() - w.lastSeen.getTime() < RECENT_MS : false;
  return {
    id: `w-${w.id}`,
    deviceId: w.tipePerangkat,
    type: "Wearable",
    kind: "Wearable",
    name: w.tipePerangkat,
    status: online ? "Terhubung" : "Terputus",
    battery: w.statusBaterai,
    lastSeen: w.lastSeen?.toISOString() ?? null,
    elderId: String(w.idLansia),
    elderName,
    pairedAt: w.tanggalPairing.toISOString(),
  };
}

function cameraDto(c: { id: number; idLansia: number; namaKamera: string; lokasi: string; status: string; lastSeen: Date | null }, elderName?: string) {
  return {
    id: `c-${c.id}`,
    deviceId: c.namaKamera,
    type: "Kamera CCTV",
    kind: "Kamera CCTV",
    name: c.namaKamera,
    status: c.status === "aktif" ? "Terhubung" : "Terputus",
    battery: null,
    lastSeen: c.lastSeen?.toISOString() ?? null,
    elderId: String(c.idLansia),
    elderName,
    pairedAt: undefined,
  };
}

router.get("/devices", async (req: AuthRequest, res) => {
  try {
    const elders = await prisma.lansia.findMany({ where: accessibleElderWhere(req.user!), select: { id: true, nama: true } });
    const names = new Map(elders.map((e) => [e.id, e.nama]));
    const ids = elders.map((e) => e.id);
    const [wearables, cameras] = await Promise.all([
      prisma.wearable.findMany({ where: { idLansia: { in: ids } }, orderBy: { id: "asc" } }),
      prisma.camera.findMany({ where: { idLansia: { in: ids } }, orderBy: { id: "asc" } }),
    ]);
    return res.json({
      data: [
        ...wearables.map((w) => wearableDto(w, names.get(w.idLansia))),
        ...cameras.map((c) => cameraDto(c, names.get(c.idLansia))),
      ],
    });
  } catch (e) {
    return fail(res, e, "Gagal mengambil perangkat");
  }
});

const deviceBody = z.object({
  deviceId: z.string().min(1).max(100),
  elderId: z.union([z.string(), z.number()]),
});

router.post("/devices/wearables", async (req: AuthRequest, res) => {
  try {
    const body = deviceBody.parse(req.body);
    const elder = await findElder(req, body.elderId);
    if (!elder) return res.status(404).json({ success: false, message: "Lansia tidak ditemukan" });
    const w = await prisma.wearable.create({ data: { idLansia: elder.id, tipePerangkat: body.deviceId.slice(0, 50) } });
    return res.status(201).json({ device: wearableDto(w, elder.nama) });
  } catch (e) {
    return fail(res, e, "Gagal mendaftarkan wearable");
  }
});

router.post("/devices/cameras", async (req: AuthRequest, res) => {
  try {
    const body = deviceBody.parse(req.body);
    const elder = await findElder(req, body.elderId);
    if (!elder) return res.status(404).json({ success: false, message: "Lansia tidak ditemukan" });
    const c = await prisma.camera.create({
      data: { idLansia: elder.id, namaKamera: body.deviceId.slice(0, 100), lokasi: "Belum diatur" },
    });
    return res.status(201).json({ device: cameraDto(c, elder.nama) });
  } catch (e) {
    return fail(res, e, "Gagal mendaftarkan kamera");
  }
});

router.post("/devices/:id/pair", async (req: AuthRequest, res) => {
  try {
    const parsed = parseDeviceId(String(req.params.id));
    if (!parsed) return res.status(400).json({ success: false, message: "ID perangkat tidak valid" });
    const { elderId } = z.object({ elderId: z.union([z.string(), z.number()]) }).parse(req.body);
    const elder = await findElder(req, elderId);
    if (!elder) return res.status(404).json({ success: false, message: "Lansia tidak ditemukan" });

    if (parsed.kind === "w") {
      const w = await prisma.wearable.update({ where: { id: parsed.id }, data: { idLansia: elder.id, tanggalPairing: new Date() } });
      return res.json({ device: wearableDto(w, elder.nama) });
    }
    const c = await prisma.camera.update({ where: { id: parsed.id }, data: { idLansia: elder.id } });
    return res.json({ device: cameraDto(c, elder.nama) });
  } catch (e) {
    return fail(res, e, "Gagal memasangkan perangkat");
  }
});

// ---------- notifikasi ----------

router.get("/notifications", async (req: AuthRequest, res) => {
  try {
    const rows = await prisma.notification.findMany({
      where: { idUserPenerima: req.user!.userId },
      include: { alert: { include: { lansia: { select: { id: true, nama: true } } } } },
      orderBy: { id: "desc" },
      take: 100,
    });
    return res.json({
      data: rows.map((n) => ({
        id: String(n.id),
        title: n.alert.jenisAnomali,
        type: n.alert.jenisAnomali,
        description: `${n.alert.jenisAnomali} pada ${n.alert.lansia.nama}`,
        level: levelLabel(n.alert.tingkatKeparahan),
        createdAt: n.alert.waktuDeteksi.toISOString(),
        readAt: n.statusBaca ? n.alert.waktuDeteksi.toISOString() : null,
        elderId: String(n.alert.lansia.id),
        elderName: n.alert.lansia.nama,
      })),
    });
  } catch (e) {
    return fail(res, e, "Gagal mengambil notifikasi");
  }
});

export default router;
