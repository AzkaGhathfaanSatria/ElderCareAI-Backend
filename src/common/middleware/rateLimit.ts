import type { NextFunction, Request, Response } from "express";

/**
 * Pembatas permintaan sederhana di memori (per IP + nama kelompok), tanpa dependensi tambahan.
 * Cukup untuk satu instance backend; bila nanti dijalankan banyak instance, ganti dengan penyimpanan bersama (mis. Redis).
 */
export function rateLimit(opts: { name: string; max: number; windowMs: number; message?: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Bersihkan entri kedaluwarsa agar memori tidak membengkak.
  setInterval(() => {
    const now = Date.now();
    for (const [key, v] of hits) if (v.resetAt <= now) hits.delete(key);
  }, Math.max(opts.windowMs, 60_000)).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.name}:${req.ip ?? "unknown"}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({
        success: false,
        message: opts.message ?? `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(retry / 60)} menit.`,
      });
    }
    return next();
  };
}
