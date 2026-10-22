import { Response, Router } from "express";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { authenticate, AuthRequest } from "../../common/middleware/auth.middleware";
import { decryptSecret, encryptSecret } from "./camera.crypto";
import { detectStream, startCamera, stopCamera, StreamConfig, workerStatus } from "./camera.worker";

/** Pengaturan stream kamera (RTSP) dari halaman Perangkat. ID kamera memakai format "c-<id>". */
const router = Router();
router.use(authenticate);

function accessibleElderWhere(user: NonNullable<AuthRequest["user"]>) {
  if (user.role === "admin") return {};
  if (user.role === "keluarga") return { idUserKeluarga: user.userId };
  return { izinAkses: { some: { idUserMedis: user.userId, status: "aktif" } } };
}

async function findCamera(req: AuthRequest, idParam: string) {
  const m = /^c-(\d+)$/.exec(idParam);
  if (!m) return null;
  const cam = await prisma.camera.findUnique({ where: { id: Number(m[1]) } });
  if (!cam) return null;
  const elder = await prisma.lansia.findFirst({ where: { id: cam.idLansia, ...accessibleElderWhere(req.user!) }, select: { id: true } });
  return elder ? cam : null;
}

function fail(res: Response, e: unknown, fallback: string) {
  if (e instanceof z.ZodError) return res.status(400).json({ success: false, message: "Data tidak valid", errors: e.issues });
  console.error(fallback, e);
  return res.status(500).json({ success: false, message: fallback });
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
const streamBody = z.object({
  host: z.string().trim().regex(HOST_RE, "IP / host tidak valid"),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  username: z.string().max(100).nullable().optional(),
  password: z.string().max(200).optional(), // kosong/tidak ada = pertahankan password lama
  path: z.string().trim().max(255).regex(/^[\x21-\x7E]*$/, "Path tidak valid").nullable().optional(),
  fps: z.number().min(0.2).max(2).default(1),
});

function dto(c: Awaited<ReturnType<typeof findCamera>> & object) {
  const st = workerStatus(c.id);
  return {
    configured: Boolean(c.streamHost),
    host: c.streamHost ?? "",
    port: c.streamPort,
    username: c.streamUser ?? "",
    hasPassword: Boolean(c.streamPassEnc),
    path: c.streamPath ?? "",
    fps: c.streamFps,
    enabled: c.streamEnabled,
    state: st.state,
    logs: st.logs,
    lastSeen: c.lastSeen?.toISOString() ?? null,
  };
}

function forbidMedis(req: AuthRequest, res: Response) {
  if (req.user!.role === "tenaga_medis") { res.status(403).json({ success: false, message: "Tidak diizinkan" }); return true; }
  return false;
}

router.get("/devices/:id/stream", async (req: AuthRequest, res) => {
  try {
    const cam = await findCamera(req, String(req.params.id));
    if (!cam) return res.status(404).json({ success: false, message: "Kamera tidak ditemukan" });
    return res.json(dto(cam));
  } catch (e) { return fail(res, e, "Gagal mengambil pengaturan stream"); }
});

router.put("/devices/:id/stream", async (req: AuthRequest, res) => {
  try {
    if (forbidMedis(req, res)) return;
    const cam = await findCamera(req, String(req.params.id));
    if (!cam) return res.status(404).json({ success: false, message: "Kamera tidak ditemukan" });
    const b = streamBody.parse(req.body);
    // password: diisi = ganti; kosong = pertahankan; username dikosongkan (kamera tanpa login) = hapus password
    const passEnc = b.password ? encryptSecret(b.password) : !b.username ? null : undefined;
    const updated = await prisma.camera.update({
      where: { id: cam.id },
      data: {
        streamHost: b.host,
        streamPort: b.port ?? null,
        streamUser: b.username || null,
        streamPath: b.path || null,
        streamFps: b.fps,
        ...(passEnc !== undefined ? { streamPassEnc: passEnc } : {}),
      },
    });
    if (updated.streamEnabled) { await stopCamera(cam.id, false); await startCamera(cam.id, false); } // terapkan pengaturan baru
    return res.json(dto(updated));
  } catch (e) { return fail(res, e, "Gagal menyimpan pengaturan stream"); }
});

router.post("/devices/:id/stream/test", async (req: AuthRequest, res) => {
  try {
    if (forbidMedis(req, res)) return;
    const cam = await findCamera(req, String(req.params.id));
    if (!cam) return res.status(404).json({ success: false, message: "Kamera tidak ditemukan" });
    const b = streamBody.partial({ fps: true }).parse(req.body ?? {});
    const host = b.host ?? cam.streamHost;
    if (!host) return res.status(400).json({ success: false, message: "IP / host belum diisi" });
    const user = b.username === undefined ? cam.streamUser : b.username || null;
    const pass = b.password ? b.password : cam.streamPassEnc ? decryptSecret(cam.streamPassEnc) : null;
    const cfg: StreamConfig = { host, port: b.port === undefined ? cam.streamPort : b.port, user, pass, path: b.path === undefined ? cam.streamPath : b.path, fps: 1 };
    return res.json(await detectStream(cfg));
  } catch (e) { return fail(res, e, "Gagal menguji koneksi"); }
});

router.post("/devices/:id/stream/start", async (req: AuthRequest, res) => {
  try {
    if (forbidMedis(req, res)) return;
    const cam = await findCamera(req, String(req.params.id));
    if (!cam) return res.status(404).json({ success: false, message: "Kamera tidak ditemukan" });
    const r = await startCamera(cam.id);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    return res.json(dto((await findCamera(req, String(req.params.id)))!));
  } catch (e) { return fail(res, e, "Gagal memulai stream"); }
});

router.post("/devices/:id/stream/stop", async (req: AuthRequest, res) => {
  try {
    if (forbidMedis(req, res)) return;
    const cam = await findCamera(req, String(req.params.id));
    if (!cam) return res.status(404).json({ success: false, message: "Kamera tidak ditemukan" });
    await stopCamera(cam.id);
    return res.json(dto((await findCamera(req, String(req.params.id)))!));
  } catch (e) { return fail(res, e, "Gagal menghentikan stream"); }
});

export default router;
