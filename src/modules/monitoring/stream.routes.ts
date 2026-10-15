import { Router } from "express";
import jwt from "jsonwebtoken";
import prisma from "../../lib/prisma";
import { bus } from "../../common/events";

/**
 * SSE realtime. EventSource di browser tidak bisa mengirim header Authorization,
 * jadi token JWT boleh dikirim lewat query ?access_token=.
 */
const router = Router();

router.get("/elders/:id/stream", async (req, res) => {
  const secret = process.env.JWT_SECRET as string;
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const token = (req.query.access_token as string | undefined) ?? bearer;
  if (!token) return res.status(401).json({ success: false, message: "Token tidak ditemukan" });

  let user: { userId: number; role: "admin" | "keluarga" | "tenaga_medis" };
  try {
    user = jwt.verify(token, secret) as typeof user;
  } catch {
    return res.status(401).json({ success: false, message: "Token tidak valid atau sudah expired" });
  }

  const id = Number(req.params.id);
  const where =
    user.role === "admin" ? {} : user.role === "keluarga" ? { idUserKeluarga: user.userId } : { izinAkses: { some: { idUserMedis: user.userId, status: "aktif" } } };
  const elder = Number.isInteger(id) ? await prisma.lansia.findFirst({ where: { id, ...where }, select: { id: true } }) : null;
  if (!elder) return res.status(404).json({ success: false, message: "Lansia tidak ditemukan" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n");

  const channel = `elder:${elder.id}`;
  const onEvent = (msg: { event: string; data: unknown }) => res.write(`event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`);
  bus.on(channel, onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(ping);
    bus.off(channel, onEvent);
  });
});

export default router;
