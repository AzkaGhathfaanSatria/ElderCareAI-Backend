/**
 * Simulator kamera: mengirim gambar ke POST /ingest/camera.
 *
 *   npm run simulate-camera -- --key ecc_xxx --image orang_jatuh.jpg --count 5 --fps 2
 *
 * Opsi: --url (default http://localhost:4000)  --image (jpg/png/webp)  --count jumlah frame (default 5)  --fps (default 2)
 * Key kamera didapat saat mendaftarkan kamera di halaman Perangkat. Gambar hanya dikirim, tidak disimpan server.
 */
import { readFileSync } from "fs";
import { extname } from "path";

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

const url = opt("url", "http://localhost:4000")!;
const key = opt("key", process.env.DEVICE_KEY);
const image = opt("image");
const count = Number(opt("count", "5"));
const fps = Number(opt("fps", "2"));
if (!key || !image) {
  console.error("Wajib: --key ecc_xxx --image path/gambar.jpg");
  process.exit(1);
}
const type = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" } as Record<string, string>)[extname(image).toLowerCase()];
if (!type) {
  console.error("Format gambar harus jpg, png, atau webp");
  process.exit(1);
}
const frame = readFileSync(image);

(async () => {
  for (let i = 1; i <= count; i++) {
    const res = await fetch(`${url}/ingest/camera`, { method: "POST", headers: { "Content-Type": type, "X-Device-Key": key! }, body: frame });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) console.log(`frame ${i}: ${res.status} ${body.message ?? ""}`);
    else console.log(`frame ${i}: ${body.fall ? `JATUH ${body.fallFrames}/${body.required}` : "tidak jatuh"}${body.alertRaised ? "  -> ALERT DIKIRIM" : ""}  ${JSON.stringify(body.deteksi)}`);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
})();
