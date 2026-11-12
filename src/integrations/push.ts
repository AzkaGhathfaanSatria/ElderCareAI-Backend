import fs from "fs";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";

/**
 * Push notification lewat Firebase Cloud Messaging (HTTP v1), tanpa dependensi tambahan.
 *
 * Aktif bila kunci service account Firebase tersedia:
 *   FCM_SERVICE_ACCOUNT_FILE=/path/ke/serviceAccount.json   (atau FCM_SERVICE_ACCOUNT_JSON= isi JSON)
 * Tanpa itu push dinonaktifkan dan alert tetap masuk lewat kanal dashboard.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let account: ServiceAccount | null | undefined; // undefined = belum dibaca

function loadAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  try {
    const file = process.env.FCM_SERVICE_ACCOUNT_FILE;
    const raw = file ? fs.readFileSync(file, "utf8") : process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      account = null;
      return null;
    }
    const j = JSON.parse(raw);
    if (!j.project_id || !j.client_email || !j.private_key) throw new Error("project_id / client_email / private_key tidak ada");
    account = j as ServiceAccount;
  } catch (e) {
    console.error("[push] kunci service account FCM tidak bisa dibaca:", (e as Error).message);
    account = null;
  }
  return account;
}

export function pushEnabled(): boolean {
  return loadAccount() !== null;
}

let cached: { token: string; expiresAt: number } | null = null;

async function getAccessToken(a: ServiceAccount): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const aud = a.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = jwt.sign({ scope: "https://www.googleapis.com/auth/firebase.messaging" }, a.private_key, {
    algorithm: "RS256",
    issuer: a.client_email,
    audience: aud,
    expiresIn: 3600,
  });
  const res = await fetch(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Nilai harus string (aturan FCM). */
  data?: Record<string, string>;
}

type SendResult = "ok" | "invalid" | "error";
type SendOutcome = { result: SendResult; detail?: string };

async function sendOne(a: ServiceAccount, accessToken: string, deviceToken: string, p: PushPayload): Promise<SendOutcome> {
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: p.title, body: p.body },
          data: p.data ?? {},
          // channel "alerts" dibuat oleh aplikasi (importance tinggi) supaya muncul sebagai heads-up + bunyi.
          android: { priority: "HIGH", notification: { channel_id: "alerts", sound: "default" } },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { result: "ok" };
    const text = await res.text();
    // Token sudah tidak berlaku (aplikasi dihapus / token rusak): hapus dari database.
    if (res.status === 404 || text.includes("UNREGISTERED") || (res.status === 400 && /message\.token|registration token/i.test(text))) {
      return { result: "invalid", detail: "token tidak berlaku" };
    }
    console.error(`[push] FCM ${res.status}: ${text.slice(0, 300)}`);
    return { result: "error", detail: `FCM ${res.status}` };
  } catch (e) {
    console.error("[push] gagal mengirim:", (e as Error).message);
    return { result: "error", detail: (e as Error).message.slice(0, 200) };
  }
}

/** Kirim ke semua perangkat milik daftar user. Tidak pernah melempar error (kegagalan push tidak boleh menghentikan alert). */
export async function sendPushToUsers(userIds: number[], payload: PushPayload) {
  const result = { enabled: pushEnabled(), tokens: 0, sent: 0, failed: 0, removed: 0 };
  const a = loadAccount();
  if (!a || userIds.length === 0) return result;
  try {
    const tokens = await prisma.pushToken.findMany({ where: { idUser: { in: userIds } }, select: { token: true } });
    result.tokens = tokens.length;
    if (tokens.length === 0) return result;

    const accessToken = await getAccessToken(a);
    const outcomes = await Promise.all(tokens.map((t) => sendOne(a, accessToken, t.token, payload)));
    const dead: string[] = [];
    outcomes.forEach((o, i) => {
      if (o.result === "ok") result.sent++;
      else if (o.result === "invalid") dead.push(tokens[i]!.token);
      else result.failed++;
    });
    if (dead.length) {
      const del = await prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
      result.removed = del.count;
    }
  } catch (e) {
    console.error("[push] sendPushToUsers:", (e as Error).message);
    result.failed = result.tokens - result.sent;
  }
  return result;
}

export interface PushDelivery {
  enabled: boolean;
  tokens: number;
  ok: number;
  invalid: number;
  error: number;
  removed: number;
  /** Keterangan kegagalan sementara terakhir (untuk kolom error_pesan). */
  detail?: string;
}

/**
 * Kirim ke semua perangkat satu user dan laporkan hasilnya per kategori.
 * `error` = kegagalan sementara (layak diulang), `invalid` = token mati (dihapus, tidak diulang).
 * Tidak pernah melempar error: kegagalan dilaporkan lewat hasil.
 */
export async function sendPushToUser(idUser: number, payload: PushPayload): Promise<PushDelivery> {
  const out: PushDelivery = { enabled: pushEnabled(), tokens: 0, ok: 0, invalid: 0, error: 0, removed: 0 };
  const a = loadAccount();
  if (!a) return out;
  try {
    const tokens = await prisma.pushToken.findMany({ where: { idUser }, select: { token: true } });
    out.tokens = tokens.length;
    if (tokens.length === 0) return out;

    const accessToken = await getAccessToken(a);
    const outcomes = await Promise.all(tokens.map((t) => sendOne(a, accessToken, t.token, payload)));
    const dead: string[] = [];
    outcomes.forEach((o, i) => {
      if (o.result === "ok") out.ok++;
      else if (o.result === "invalid") {
        out.invalid++;
        dead.push(tokens[i]!.token);
      } else {
        out.error++;
        out.detail = o.detail;
      }
    });
    if (dead.length) {
      const del = await prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
      out.removed = del.count;
    }
  } catch (e) {
    console.error("[push] sendPushToUser:", (e as Error).message);
    out.error = Math.max(out.tokens - out.ok - out.invalid, 1);
    out.detail = (e as Error).message.slice(0, 200);
  }
  return out;
}
