import crypto from "crypto";
import { prismaMock, resetPrismaMock } from "./helpers/prismaMock";

jest.mock("../src/lib/prisma", () => ({ __esModule: true, default: require("./helpers/prismaMock").prismaMock }));

/** Klasifikasi respons FCM: 'invalid' (token mati, dihapus, tidak diulang) vs 'error' (sementara, layak diulang). */
type PushModule = typeof import("../src/integrations/push");
let push: PushModule;
let fcmResponse: () => Response | Promise<Response>;

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  // Kunci dibaca sekali saat modul dimuat, jadi env diisi dulu baru modul di-require.
  process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: "demo", client_email: "x@demo.iam", private_key: privateKey });
  push = require("../src/integrations/push");

  jest.spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => {
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    return fcmResponse();
  }) as typeof fetch);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

beforeEach(() => {
  resetPrismaMock();
  prismaMock.pushToken.findMany.mockResolvedValue([{ token: "tok-1" }]);
  prismaMock.pushToken.deleteMany.mockResolvedValue({ count: 1 });
});

const payload = { title: "t", body: "b" };

describe("sendPushToUser", () => {
  it("200 -> ok", async () => {
    fcmResponse = () => new Response("{}", { status: 200 });
    expect(await push.sendPushToUser(1, payload)).toMatchObject({ enabled: true, tokens: 1, ok: 1, invalid: 0, error: 0 });
  });

  it("404 UNREGISTERED -> invalid, token dihapus dari database", async () => {
    fcmResponse = () => new Response('{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 });
    const r = await push.sendPushToUser(1, payload);
    expect(r).toMatchObject({ ok: 0, invalid: 1, error: 0, removed: 1 });
    expect(prismaMock.pushToken.deleteMany).toHaveBeenCalledWith({ where: { token: { in: ["tok-1"] } } });
  });

  it("500 -> error (sementara), token TIDAK dihapus", async () => {
    fcmResponse = () => new Response("boom", { status: 500 });
    const r = await push.sendPushToUser(1, payload);
    expect(r).toMatchObject({ ok: 0, invalid: 0, error: 1, detail: "FCM 500" });
    expect(prismaMock.pushToken.deleteMany).not.toHaveBeenCalled();
  });

  it("gangguan jaringan -> error, tidak melempar", async () => {
    fcmResponse = () => Promise.reject(new Error("ECONNRESET"));
    const r = await push.sendPushToUser(1, payload);
    expect(r.error).toBe(1);
    expect(r.detail).toContain("ECONNRESET");
  });

  it("user tanpa token -> tokens 0, FCM tidak dipanggil", async () => {
    prismaMock.pushToken.findMany.mockResolvedValue([]);
    const r = await push.sendPushToUser(1, payload);
    expect(r).toMatchObject({ enabled: true, tokens: 0, ok: 0, error: 0 });
  });

  it("gagal membaca token dari database -> dilaporkan sebagai error (bisa diulang)", async () => {
    prismaMock.pushToken.findMany.mockRejectedValue(new Error("db putus"));
    const r = await push.sendPushToUser(1, payload);
    expect(r.error).toBeGreaterThanOrEqual(1);
  });
});
