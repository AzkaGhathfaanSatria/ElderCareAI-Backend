import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Enkripsi password kamera (AES-256-GCM). Kunci diambil dari CAMERA_SECRET_KEY,
 * atau JWT_SECRET bila tidak diset. Jika kunci berubah, password kamera harus diisi ulang.
 */
function key() {
  const secret = process.env.CAMERA_SECRET_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error("CAMERA_SECRET_KEY atau JWT_SECRET harus diset");
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(payload: string): string | null {
  try {
    const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64"));
    if (!iv || !tag || !enc) return null;
    const d = createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
