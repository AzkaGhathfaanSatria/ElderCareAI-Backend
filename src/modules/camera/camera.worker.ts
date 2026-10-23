import { ChildProcess, spawn } from "child_process";
import { randomBytes } from "crypto";
import net from "net";
import path from "path";
import prisma from "../../lib/prisma";
import { decryptSecret } from "./camera.crypto";

/**
 * Pengelola worker kamera: satu proses `scripts/camera_bridge.py` per kamera yang diaktifkan dari halaman Perangkat.
 * Worker memanggil POST /ingest/camera milik server ini sendiri, memakai token internal acak
 * (dibuat tiap server menyala, tidak pernah ditulis ke disk). Alamat RTSP + password dikirim lewat
 * environment variable, bukan argumen perintah, supaya tidak terlihat di daftar proses.
 */

export const INTERNAL_TOKEN = randomBytes(32).toString("hex");

const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const BRIDGE = path.resolve(process.cwd(), "scripts", "camera_bridge.py");
const EXIT_AUTH = 3; // key/token ditolak: jangan dicoba ulang terus
const LOG_LINES = 30;

export interface StreamConfig {
  host: string;
  port: number | null;
  user: string | null;
  pass: string | null;
  path: string | null;
  fps: number;
}

type State = "stopped" | "starting" | "running" | "error";
interface Worker {
  proc: ChildProcess | null;
  state: State;
  logs: string[];
  restarts: number;
  wantRunning: boolean;
  timer: NodeJS.Timeout | null;
}

const workers = new Map<number, Worker>();

export function buildRtspUrl(c: StreamConfig): string {
  const auth = c.user ? `${encodeURIComponent(c.user)}${c.pass ? ":" + encodeURIComponent(c.pass) : ""}@` : "";
  const port = c.port ? `:${c.port}` : "";
  const p = c.path ? (c.path.startsWith("/") ? c.path : "/" + c.path) : "";
  return `rtsp://${auth}${c.host}${port}${p}`;
}

/** Hilangkan kredensial dari teks log sebelum disimpan/ditampilkan. */
function scrub(line: string) {
  return line.replace(/rtsp:\/\/[^@\s/]+@/gi, "rtsp://***@");
}

function pushLog(w: Worker, text: string) {
  for (const raw of text.split(/\r?\n/)) {
    const line = scrub(raw).trim();
    if (!line) continue;
    w.logs.push(`${new Date().toLocaleTimeString("id-ID", { hour12: false })} ${line}`);
  }
  if (w.logs.length > LOG_LINES) w.logs.splice(0, w.logs.length - LOG_LINES);
}

function backendUrl() {
  return `http://127.0.0.1:${process.env.PORT || 4000}`;
}

async function loadConfig(cameraId: number): Promise<StreamConfig | null> {
  const c = await prisma.camera.findUnique({ where: { id: cameraId } });
  if (!c || !c.streamHost) return null;
  return {
    host: c.streamHost,
    port: c.streamPort,
    user: c.streamUser,
    pass: c.streamPassEnc ? decryptSecret(c.streamPassEnc) : null,
    path: c.streamPath,
    fps: c.streamFps,
  };
}

function launch(cameraId: number, cfg: StreamConfig, w: Worker) {
  w.state = "starting";
  const proc = spawn(
    PYTHON_BIN,
    [BRIDGE, "--url", backendUrl(), "--fps", String(cfg.fps), "--width", "640"],
    {
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", CAMERA_SOURCE: buildRtspUrl(cfg), CAMERA_ID: String(cameraId), INTERNAL_TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  w.proc = proc;
  const onData = (d: Buffer) => {
    const text = d.toString("utf8");
    pushLog(w, text);
    if (/^#\d+/m.test(text)) w.state = "running";
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("error", (e) => {
    w.state = "error";
    pushLog(w, `Gagal menjalankan ${PYTHON_BIN}: ${e.message}. Pasang Python + opencv-python + requests, atau set PYTHON_BIN.`);
    w.proc = null;
    w.wantRunning = false;
  });
  proc.on("exit", (code) => {
    w.proc = null;
    if (!w.wantRunning) { w.state = "stopped"; return; }
    if (code === EXIT_AUTH) {
      w.state = "error";
      w.wantRunning = false;
      pushLog(w, "Server menolak worker (401). Worker dihentikan.");
      return;
    }
    w.state = "error";
    w.restarts += 1;
    const delay = Math.min(30_000, 2_000 * w.restarts);
    pushLog(w, `Worker berhenti (kode ${code}). Mencoba lagi dalam ${Math.round(delay / 1000)} dtk...`);
    w.timer = setTimeout(() => {
      w.timer = null;
      if (w.wantRunning) void startCamera(cameraId, false);
    }, delay);
  });
}

export async function startCamera(cameraId: number, persist = true): Promise<{ ok: boolean; message?: string }> {
  const cfg = await loadConfig(cameraId);
  if (!cfg) return { ok: false, message: "Pengaturan stream kamera belum diisi" };
  if (!cfg.port || !cfg.path) {
    const d = await detectStream(cfg);
    if (!d.ok) return { ok: false, message: d.message };
    cfg.port = d.port ?? null;
    cfg.path = d.path ?? null;
    // Simpan hasil deteksi supaya start berikutnya (dan setelah restart server) langsung cepat.
    await prisma.camera.update({ where: { id: cameraId }, data: { streamPort: cfg.port, streamPath: cfg.path } });
  }
  let w = workers.get(cameraId);
  if (!w) {
    w = { proc: null, state: "stopped", logs: [], restarts: 0, wantRunning: false, timer: null };
    workers.set(cameraId, w);
  }
  if (w.proc) return { ok: true };
  if (w.timer) { clearTimeout(w.timer); w.timer = null; }
  if (persist) w.restarts = 0;
  w.wantRunning = true;
  launch(cameraId, cfg, w);
  if (persist) await prisma.camera.update({ where: { id: cameraId }, data: { streamEnabled: true } });
  return { ok: true };
}

export async function stopCamera(cameraId: number, persist = true) {
  const w = workers.get(cameraId);
  if (w) {
    w.wantRunning = false;
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    w.proc?.kill();
    w.state = "stopped";
  }
  if (persist) await prisma.camera.update({ where: { id: cameraId }, data: { streamEnabled: false } });
}

export function workerStatus(cameraId: number) {
  const w = workers.get(cameraId);
  return { state: (w?.state ?? "stopped") as State, logs: w?.logs ?? [] };
}

const DEFAULT_PORTS = [554, 8554];
// Path RTSP yang umum dipakai berbagai merek, stream utama dulu.
const COMMON_PATHS = [
  "/Streaming/Channels/101", // Hikvision
  "/cam/realmonitor?channel=1&subtype=0", // Dahua / Imou / Amcrest
  "/stream1", // TP-Link Tapo & banyak CCTV generik
  "/h264Preview_01_main", // Reolink
  "/stream",
  "/live/ch00_0",
  "/11", // Xiongmai & CCTV generik
  "/1",
  "/Streaming/Channels/1",
  "/Streaming/Channels/102",
  "/live",
  "/onvif1",
  "/axis-media/media.amp", // Axis
  "/videoMain", // Foscam
  "/ch0_0.h264",
  "",
];

type PortState = "rtsp" | "silent" | "closed";

/** Cek port: apakah tertutup, terbuka tapi diam, atau benar-benar membalas protokol RTSP (kirim OPTIONS). */
function checkPort(host: string, port: number, ms = 4000): Promise<PortState> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (r: PortState) => { if (settled) return; settled = true; sock.destroy(); resolve(r); };
    sock.setTimeout(ms, () => done("silent"));
    sock.once("connect", () => sock.write(`OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\n\r\n`));
    sock.once("data", (d) => done(d.toString("latin1").startsWith("RTSP/") ? "rtsp" : "silent"));
    sock.once("close", () => done("silent"));
    sock.once("error", () => done("closed"));
  });
}

function runProbe(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean; spawnError?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, [BRIDGE, "--probe"], { env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));
    proc.on("error", (e) => { clearTimeout(timer); resolve({ code: null, out, timedOut, spawnError: e.message }); });
    proc.on("exit", (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
  });
}

export interface DetectResult { ok: boolean; message: string; port?: number; path?: string }

/**
 * Cari alamat stream yang benar. Jika port/path belum diisi, coba port & path umum otomatis
 * (port yang tertutup dilewati cepat lewat cek TCP). Hasilnya dipakai tombol "Tes koneksi" dan "Mulai".
 */
export async function detectStream(cfg: StreamConfig): Promise<DetectResult> {
  const ports = cfg.port ? [cfg.port] : DEFAULT_PORTS;
  const open: number[] = [];
  const silent: number[] = [];
  for (const p of ports) {
    const st = await checkPort(cfg.host, p);
    if (st === "rtsp") open.push(p);
    else if (st === "silent") silent.push(p);
  }
  if (!open.length) {
    if (silent.length) return { ok: false, message: `Port ${silent.join("/")} di ${cfg.host} terbuka, tetapi tidak membalas sebagai kamera RTSP. Periksa IP dan port kamera.` };
    return { ok: false, message: `Kamera tidak terjangkau di ${cfg.host} (port ${ports.join("/")} tertutup). Periksa IP, pastikan laptop dan kamera satu jaringan, dan kamera menyala.` };
  }
  const paths = cfg.path ? [cfg.path] : COMMON_PATHS;
  const cands = open.flatMap((port) => paths.map((path) => ({ port, path })));
  const urls = cands.map((c) => buildRtspUrl({ ...cfg, port: c.port, path: c.path || null }));
  const r = await runProbe({ CAMERA_SOURCE: urls[0], CAMERA_CANDIDATES: JSON.stringify(urls), CAMERA_OPEN_MS: "12000" }, 120_000);
  if (r.spawnError) return { ok: false, message: `Tidak bisa menjalankan ${PYTHON_BIN} (${r.spawnError}). Pasang Python + opencv-python + requests.` };
  const m = /PROBE_OK (\d+) (\S+)/.exec(r.out);
  if (m) {
    const hit = cands[Number(m[1])];
    return { ok: true, port: hit.port, path: hit.path, message: `Terhubung otomatis (port ${hit.port}${hit.path ? ", " + hit.path : ""}), gambar ${m[2]} diterima.` };
  }
  // Python sendiri yang error (bukan masalah kamera): tampilkan penyebab aslinya, jangan menebak soal password.
  if (/SyntaxError|ModuleNotFoundError|ImportError|Pasang dulu|Traceback/.test(r.out)) {
    const tail = scrub(r.out.trim().split(/\r?\n/).filter(Boolean).slice(-1).join(" "));
    return { ok: false, message: `Program Python gagal berjalan (bukan masalah kamera): ${tail}` };
  }
  if (/tidak membalas/.test(r.out)) return { ok: false, message: `Port terbuka di ${cfg.host}, tetapi tidak membalas sebagai kamera RTSP. Periksa IP dan port kameranya.` };
  if (r.timedOut) return { ok: false, message: "Waktu habis saat mencari alamat stream. Coba isi Port dan Path di Pengaturan lanjutan." };
  return { ok: false, message: cfg.path ? "Gagal membuka stream. Periksa username, password, dan path." : "Kamera terjangkau, tetapi stream tidak bisa dibuka. Username/password mungkin salah, atau merek kamera memakai path khusus (isi di Pengaturan lanjutan)." };
}

/** Panggil saat server menyala: sambungkan lagi kamera yang terakhir dalam keadaan aktif. */
export async function resumeEnabledCameras() {
  try {
    const cams = await prisma.camera.findMany({ where: { streamEnabled: true, streamHost: { not: null } }, select: { id: true } });
    for (const c of cams) await startCamera(c.id, false);
    if (cams.length) console.log(`Worker kamera dilanjutkan: ${cams.length}`);
  } catch (e) {
    console.error("resumeEnabledCameras", e);
  }
}

function killAll() {
  for (const w of workers.values()) { w.wantRunning = false; w.proc?.kill(); }
}
process.on("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { killAll(); process.exit(0); });
