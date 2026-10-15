import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { authenticate, AuthRequest } from "../../common/middleware/auth.middleware";
import { baselineStatus, trainElderBaseline } from "../baseline/baseline.service";

/**
 * Route pelengkap agar semua halaman frontend punya endpoint (data kosong tetap 200, bukan 404):
 * preferensi notifikasi, push token, izin akses medis, manajemen user (admin), alert, konfirmasi jatuh.
 */
const router = Router();
router.use(authenticate);

function fail(res: any, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ success: false, message: "Data tidak valid", errors: error.issues });
  }
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback });
}

function accessibleElderWhere(user: NonNullable<AuthRequest["user"]>) {
  if (user.role === "admin") return {};
  if (user.role === "keluarga") return { idUserKeluarga: user.userId };
  return { izinAkses: { some: { idUserMedis: user.userId, status: "aktif" } } };
}

function requireAdmin(req: AuthRequest, res: any, next: any) {
  if (req.user?.role !== "admin") return res.status(403).json({ success: false, message: "Khusus admin" });
  next();
}

const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

// ---------- preferensi notifikasi & push token ----------

function prefDto(p: { dashboard: boolean; push: boolean; whatsapp: boolean; email: boolean; levelMinimum: string; weeklySummary: boolean } | null) {
  const v = p ?? { dashboard: true, push: true, whatsapp: false, email: false, levelMinimum: "sedang", weeklySummary: false };
  const channels = (["dashboard", "push", "whatsapp", "email"] as const).filter((c) => v[c]);
  return { channels, dashboard: v.dashboard, push: v.push, whatsapp: v.whatsapp, email: v.email, weeklySummary: v.weeklySummary, weekly_summary: v.weeklySummary, minimumLevel: cap(v.levelMinimum), level_minimum: cap(v.levelMinimum) };
}

router.get("/me/notification-preferences", async (req: AuthRequest, res) => {
  try {
    const p = await prisma.notificationPreference.findUnique({ where: { idUser: req.user!.userId } });
    return res.json(prefDto(p));
  } catch (e) {
    return fail(res, e, "Gagal mengambil preferensi");
  }
});

router.put("/me/notification-preferences", async (req: AuthRequest, res) => {
  try {
    const b = z
      .object({
        email: z.boolean().optional(),
        push: z.boolean().optional(),
        whatsapp: z.boolean().optional(),
        dashboard: z.boolean().optional(),
        weeklySummary: z.boolean().optional(),
        weekly_summary: z.boolean().optional(),
        minimumLevel: z.string().optional(),
        level_minimum: z.string().optional(),
      })
      .passthrough()
      .parse(req.body);
    const lvl = (b.minimumLevel ?? b.level_minimum ?? "").toLowerCase();
    const levelMinimum = ["rendah", "sedang", "tinggi"].includes(lvl) ? lvl : undefined;
    const data = { email: b.email, push: b.push, whatsapp: b.whatsapp, dashboard: b.dashboard, levelMinimum, weeklySummary: b.weeklySummary ?? b.weekly_summary };
    const p = await prisma.notificationPreference.upsert({
      where: { idUser: req.user!.userId },
      update: data,
      create: { idUser: req.user!.userId, ...data },
    });
    return res.json(prefDto(p));
  } catch (e) {
    return fail(res, e, "Gagal menyimpan preferensi");
  }
});

router.post("/me/push-tokens", async (req: AuthRequest, res) => {
  try {
    const b = z.object({ token: z.string().min(1).max(500), platform: z.string().max(30).optional() }).parse(req.body);
    await prisma.pushToken.upsert({
      where: { token: b.token },
      update: { idUser: req.user!.userId, platform: b.platform },
      create: { idUser: req.user!.userId, token: b.token, platform: b.platform },
    });
    return res.status(201).json({ success: true });
  } catch (e) {
    return fail(res, e, "Gagal menyimpan push token");
  }
});

// ---------- izin akses medis ----------

async function ownedElder(req: AuthRequest, res: any) {
  const role = req.user!.role;
  if (role === "tenaga_medis") {
    res.status(403).json({ success: false, message: "Hanya keluarga yang dapat mengelola izin akses" });
    return null;
  }
  const id = Number(req.params.id);
  const elder = Number.isInteger(id) ? await prisma.lansia.findFirst({ where: { id, ...accessibleElderWhere(req.user!) } }) : null;
  if (!elder) {
    res.status(404).json({ success: false, message: "Lansia tidak ditemukan" });
    return null;
  }
  return elder;
}

router.get("/elders/:id/access-grants", async (req: AuthRequest, res) => {
  try {
    const elder = await ownedElder(req, res);
    if (!elder) return;
    const grants = await prisma.accessGrant.findMany({ where: { idLansia: elder.id }, orderBy: { id: "asc" } });
    const users = await prisma.user.findMany({ where: { id: { in: grants.map((g) => g.idUserMedis) } }, select: { id: true, nama: true, email: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return res.json({
      data: grants.map((g) => ({
        id: String(g.id),
        userId: String(g.idUserMedis),
        name: byId.get(g.idUserMedis)?.nama,
        email: byId.get(g.idUserMedis)?.email,
        specialization: "Tenaga Medis",
        status: g.status,
        grantedAt: g.createdAt.toISOString().slice(0, 10),
      })),
    });
  } catch (e) {
    return fail(res, e, "Gagal mengambil izin akses");
  }
});

router.post("/elders/:id/access-grants", async (req: AuthRequest, res) => {
  try {
    const elder = await ownedElder(req, res);
    if (!elder) return;
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const medis = await prisma.user.findUnique({ where: { email } });
    if (!medis || medis.role !== "tenaga_medis") {
      return res.status(404).json({ success: false, message: "Akun tenaga medis dengan email tersebut tidak ditemukan" });
    }
    const grant = await prisma.accessGrant.upsert({
      where: { idLansia_idUserMedis: { idLansia: elder.id, idUserMedis: medis.id } },
      update: { status: "aktif" },
      create: { idLansia: elder.id, idUserMedis: medis.id, status: "aktif" },
    });
    return res.status(201).json({ grant: { id: String(grant.id), status: grant.status } });
  } catch (e) {
    return fail(res, e, "Gagal memberi izin akses");
  }
});

router.delete("/elders/:id/access-grants", async (req: AuthRequest, res) => {
  try {
    const elder = await ownedElder(req, res);
    if (!elder) return;
    const { grantId } = z.object({ grantId: z.union([z.string(), z.number()]) }).parse(req.body);
    const result = await prisma.accessGrant.updateMany({ where: { id: Number(grantId), idLansia: elder.id }, data: { status: "dicabut" } });
    if (result.count === 0) return res.status(404).json({ success: false, message: "Izin akses tidak ditemukan" });
    return res.json({ success: true });
  } catch (e) {
    return fail(res, e, "Gagal mencabut izin akses");
  }
});

// ---------- manajemen user (admin) ----------

const userDto = (u: { id: number; nama: string; email: string; role: string; status: string; createdAt: Date }) => ({
  id: String(u.id),
  nama: u.nama,
  email: u.email,
  role: u.role,
  status: cap(u.status),
  createdAt: u.createdAt.toISOString(),
});

router.get("/users", requireAdmin, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { id: "asc" }, select: { id: true, nama: true, email: true, role: true, status: true, createdAt: true } });
    return res.json({ data: users.map(userDto) });
  } catch (e) {
    return fail(res, e, "Gagal mengambil pengguna");
  }
});

router.post("/users", requireAdmin, async (req, res) => {
  try {
    const b = z
      .object({
        name: z.string().min(2).max(100).optional(),
        nama: z.string().min(2).max(100).optional(),
        email: z.string().email().max(150),
        password: z.string().min(8),
        role: z.enum(["admin", "keluarga", "tenaga_medis"]).default("keluarga"),
      })
      .parse(req.body);
    const nama = b.nama ?? b.name;
    if (!nama) return res.status(400).json({ success: false, message: "Nama wajib diisi" });
    if (await prisma.user.findUnique({ where: { email: b.email } })) {
      return res.status(400).json({ success: false, message: "Email sudah terdaftar" });
    }
    const u = await prisma.user.create({
      data: { nama, email: b.email, password: await bcrypt.hash(b.password, 10), role: b.role },
      select: { id: true, nama: true, email: true, role: true, status: true, createdAt: true },
    });
    return res.status(201).json({ user: userDto(u) });
  } catch (e) {
    return fail(res, e, "Gagal membuat pengguna");
  }
});

router.patch("/users/:id", requireAdmin, async (req, res) => {
  try {
    const b = z
      .object({
        name: z.string().min(2).max(100).optional(),
        nama: z.string().min(2).max(100).optional(),
        email: z.string().email().max(150).optional(),
        role: z.enum(["admin", "keluarga", "tenaga_medis"]).optional(),
        status: z.string().optional(),
      })
      .passthrough()
      .parse(req.body);
    const targetId = Number(req.params.id);
    const status = b.status === undefined ? undefined : b.status.toLowerCase();
    if (status !== undefined && status !== "aktif" && status !== "nonaktif") {
      return res.status(400).json({ success: false, message: "Status harus Aktif atau Nonaktif" });
    }
    if (status === "nonaktif" && targetId === (req as AuthRequest).user!.userId) {
      return res.status(400).json({ success: false, message: "Tidak dapat menonaktifkan akun sendiri" });
    }
    const u = await prisma.user.update({
      where: { id: targetId },
      data: { nama: b.nama ?? b.name, email: b.email, role: b.role, status },
      select: { id: true, nama: true, email: true, role: true, status: true, createdAt: true },
    });
    // Akun dinonaktifkan: cabut semua sesi (refresh token) supaya tidak bisa memperpanjang akses.
    if (status === "nonaktif") {
      await prisma.refreshToken.updateMany({ where: { idUser: targetId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return res.json({ user: userDto(u) });
  } catch (e: any) {
    if (e?.code === "P2025") return res.status(404).json({ success: false, message: "Pengguna tidak ditemukan" });
    if (e?.code === "P2002") return res.status(400).json({ success: false, message: "Email sudah dipakai" });
    return fail(res, e, "Gagal memperbarui pengguna");
  }
});

router.delete("/users/:id", requireAdmin, async (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user!.userId) return res.status(400).json({ success: false, message: "Tidak dapat menghapus akun sendiri" });
    await prisma.$transaction([
      prisma.refreshToken.deleteMany({ where: { idUser: id } }),
      prisma.notificationPreference.deleteMany({ where: { idUser: id } }),
      prisma.pushToken.deleteMany({ where: { idUser: id } }),
      prisma.user.delete({ where: { id } }),
    ]);
    return res.json({ success: true });
  } catch (e: any) {
    if (e?.code === "P2025") return res.status(404).json({ success: false, message: "Pengguna tidak ditemukan" });
    if (e?.code === "P2003") return res.status(400).json({ success: false, message: "Pengguna masih memiliki data terkait (lansia/notifikasi)" });
    return fail(res, e, "Gagal menghapus pengguna");
  }
});

// ---------- baseline perilaku per lansia ----------

async function readableElder(req: AuthRequest, res: any) {
  const id = Number(req.params.id);
  const elder = Number.isInteger(id) ? await prisma.lansia.findFirst({ where: { id, ...accessibleElderWhere(req.user!) } }) : null;
  if (!elder) res.status(404).json({ success: false, message: "Lansia tidak ditemukan" });
  return elder;
}

router.get("/elders/:id/baseline", async (req: AuthRequest, res) => {
  try {
    const elder = await readableElder(req, res);
    if (!elder) return;
    return res.json(await baselineStatus(elder.id));
  } catch (e) {
    return fail(res, e, "Gagal mengambil baseline");
  }
});

router.post("/elders/:id/baseline/train", async (req: AuthRequest, res) => {
  try {
    if (req.user!.role === "tenaga_medis") {
      return res.status(403).json({ success: false, message: "Hanya keluarga atau admin yang dapat memperbarui baseline" });
    }
    const elder = await readableElder(req, res);
    if (!elder) return;
    const result = await trainElderBaseline(elder.id);
    if (!result.ok) return res.status(result.code).json({ success: false, message: result.reason });
    return res.json({ success: true, ...(await baselineStatus(elder.id)) });
  } catch (e) {
    return fail(res, e, "Gagal memperbarui baseline");
  }
});

// ---------- status baca notifikasi ----------

router.patch("/notifications/:id/read", async (req: AuthRequest, res) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { id: BigInt(req.params.id as string), idUserPenerima: req.user!.userId },
      data: { statusBaca: true },
    });
    if (result.count === 0) return res.status(404).json({ success: false, message: "Notifikasi tidak ditemukan" });
    return res.json({ success: true });
  } catch (e) {
    return fail(res, e, "Gagal menandai notifikasi");
  }
});

router.post("/notifications/read-all", async (req: AuthRequest, res) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { idUserPenerima: req.user!.userId, statusBaca: false },
      data: { statusBaca: true },
    });
    return res.json({ success: true, updated: result.count });
  } catch (e) {
    return fail(res, e, "Gagal menandai notifikasi");
  }
});

// ---------- alert & konfirmasi jatuh ----------

router.patch("/alerts/:id", async (req: AuthRequest, res) => {
  try {
    const { status } = z.object({ status: z.enum(["baru", "ditindaklanjuti", "selesai"]) }).parse(req.body);
    const alert = await prisma.alert.findFirst({ where: { id: BigInt(req.params.id as string), lansia: accessibleElderWhere(req.user!) } });
    if (!alert) return res.status(404).json({ success: false, message: "Alert tidak ditemukan" });
    const updated = await prisma.alert.update({ where: { id: alert.id }, data: { status } });
    return res.json({ alert: { id: String(updated.id), status: updated.status } });
  } catch (e) {
    return fail(res, e, "Gagal memperbarui alert");
  }
});

router.patch("/falls/:id/confirm", async (req: AuthRequest, res) => {
  try {
    const { confirmed } = z.object({ confirmed: z.boolean() }).parse(req.body);
    const fall = await prisma.fallEvent.findFirst({ where: { id: BigInt(req.params.id as string), lansia: accessibleElderWhere(req.user!) } });
    if (!fall) return res.status(404).json({ success: false, message: "Kejadian jatuh tidak ditemukan" });
    await prisma.fallEvent.update({ where: { id: fall.id }, data: { konfirmasi: confirmed, falseAlarm: !confirmed } });
    // Terkonfirmasi -> alert ditindaklanjuti; alarm palsu -> alert selesai (hilang dari dashboard).
    await prisma.alert.updateMany({ where: { idJatuh: fall.id }, data: { status: confirmed ? "ditindaklanjuti" : "selesai" } });
    return res.json({ success: true });
  } catch (e) {
    return fail(res, e, "Gagal mengonfirmasi kejadian jatuh");
  }
});

export default router;
