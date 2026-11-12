import { prismaMock, resetPrismaMock } from "./helpers/prismaMock";

jest.mock("../src/lib/prisma", () => ({ __esModule: true, default: require("./helpers/prismaMock").prismaMock }));
jest.mock("../src/integrations/push", () => ({ sendPushToUser: jest.fn() }));

import { sendPushToUser } from "../src/integrations/push";
import { buildPayload, dispatchPending, MAX_ATTEMPTS } from "../src/modules/notifications/outbox";

const sendPush = sendPushToUser as jest.Mock;

type Channel = "dashboard" | "push" | "whatsapp";
function row(over: Partial<{ id: bigint; channel: Channel; percobaanKe: number; tingkat: string }> = {}) {
  return {
    id: over.id ?? 10n,
    idAlert: 5n,
    idUserPenerima: 1,
    channel: over.channel ?? "push",
    status: "pending",
    percobaanKe: over.percobaanKe ?? 0,
    alert: {
      id: 5n,
      idLansia: 3,
      jenisAnomali: "Detak jantung terlalu tinggi",
      tingkatKeparahan: over.tingkat ?? "tinggi",
      lansia: { id: 3, nama: "Bu Siti" },
    },
  };
}

const delivery = (over: object = {}) => ({ enabled: true, tokens: 1, ok: 0, invalid: 0, error: 0, removed: 0, ...over });
/** Argumen `data` dari panggilan update terakhir. */
const lastUpdate = () => prismaMock.notification.update.mock.calls.at(-1)?.[0].data;

function queue(...rows: ReturnType<typeof row>[]) {
  prismaMock.notification.findMany.mockResolvedValue(rows);
  prismaMock.notification.updateMany.mockResolvedValue({ count: 1 }); // klaim berhasil
  prismaMock.notification.update.mockResolvedValue({});
}

beforeEach(() => {
  resetPrismaMock();
  sendPush.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("pemilihan baris", () => {
  it("hanya mengambil baris 'pending' yang percobaannya masih di bawah batas, berurutan", async () => {
    queue();
    await dispatchPending();
    expect(prismaMock.notification.findMany.mock.calls[0][0]).toMatchObject({
      where: { status: "pending", percobaanKe: { lt: MAX_ATTEMPTS } },
      orderBy: { id: "asc" },
    });
  });

  it("melewati baris yang sudah diklaim proses lain (tidak mengirim, tidak mengubah)", async () => {
    queue(row());
    prismaMock.notification.updateMany.mockResolvedValue({ count: 0 });
    const stats = await dispatchPending();
    expect(stats.skipped).toBe(1);
    expect(sendPush).not.toHaveBeenCalled();
    expect(prismaMock.notification.update).not.toHaveBeenCalled();
  });

  it("klaim menaikkan percobaan_ke dengan syarat nilai lamanya (optimistic lock)", async () => {
    queue(row({ channel: "dashboard", percobaanKe: 1 }));
    await dispatchPending();
    expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 10n, status: "pending", percobaanKe: 1 },
      data: { percobaanKe: 2 },
    });
  });
});

describe("kanal dashboard", () => {
  it("langsung 'terkirim' tanpa memanggil FCM", async () => {
    queue(row({ channel: "dashboard" }));
    const stats = await dispatchPending();
    expect(stats.sent).toBe(1);
    expect(lastUpdate()).toMatchObject({ status: "terkirim", errorPesan: null, waktuKirim: expect.any(Date) });
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("kanal yang belum didukung ditandai 'gagal' dengan alasan", async () => {
    queue(row({ channel: "whatsapp" }));
    await dispatchPending();
    expect(lastUpdate()).toMatchObject({ status: "gagal", errorPesan: expect.stringContaining("belum didukung") });
  });
});

describe("kanal push: retry hanya untuk hasil 'error'", () => {
  it("berhasil -> 'terkirim'", async () => {
    queue(row());
    sendPush.mockResolvedValue(delivery({ ok: 1 }));
    await dispatchPending();
    expect(lastUpdate()).toMatchObject({ status: "terkirim", errorPesan: null });
  });

  it("sebagian perangkat berhasil -> 'terkirim' (tidak diulang ke perangkat yang sudah menerima)", async () => {
    queue(row());
    sendPush.mockResolvedValue(delivery({ tokens: 2, ok: 1, error: 1 }));
    await dispatchPending();
    expect(lastUpdate().status).toBe("terkirim");
  });

  it("error percobaan ke-1 -> tetap 'pending' dengan error_pesan, akan diulang", async () => {
    queue(row({ percobaanKe: 0 }));
    sendPush.mockResolvedValue(delivery({ error: 1, detail: "FCM 500" }));
    const stats = await dispatchPending();
    expect(stats.retry).toBe(1);
    expect(lastUpdate()).toMatchObject({ status: "pending", errorPesan: "Percobaan 1/3 gagal: FCM 500" });
  });

  it("error percobaan ke-2 -> masih 'pending'", async () => {
    queue(row({ percobaanKe: 1 }));
    sendPush.mockResolvedValue(delivery({ error: 1, detail: "FCM 503" }));
    await dispatchPending();
    expect(lastUpdate()).toMatchObject({ status: "pending", errorPesan: "Percobaan 2/3 gagal: FCM 503" });
  });

  it("error percobaan ke-3 -> 'gagal' dan tidak diulang lagi", async () => {
    queue(row({ percobaanKe: 2 }));
    sendPush.mockResolvedValue(delivery({ error: 1, detail: "FCM 500" }));
    const stats = await dispatchPending();
    expect(stats.failed).toBe(1);
    expect(lastUpdate()).toMatchObject({ status: "gagal", errorPesan: "Percobaan 3/3 gagal: FCM 500" });
    expect(prismaMock.notification.updateMany.mock.calls[0][0].data).toEqual({ percobaanKe: 3 });
  });

  it("token tidak valid ('invalid') -> langsung 'gagal', tidak diulang", async () => {
    queue(row({ percobaanKe: 0 }));
    sendPush.mockResolvedValue(delivery({ invalid: 1, removed: 1 }));
    await dispatchPending();
    expect(lastUpdate()).toMatchObject({ status: "gagal", errorPesan: expect.stringContaining("tidak valid") });
  });

  it("FCM nonaktif -> 'gagal' permanen dengan alasan jelas", async () => {
    queue(row());
    sendPush.mockResolvedValue(delivery({ enabled: false, tokens: 0 }));
    await dispatchPending();
    expect(lastUpdate()).toMatchObject({ status: "gagal", errorPesan: expect.stringContaining("FCM") });
  });

  it("user tanpa perangkat terdaftar -> 'gagal' permanen", async () => {
    queue(row());
    sendPush.mockResolvedValue(delivery({ tokens: 0 }));
    await dispatchPending();
    expect(lastUpdate()).toMatchObject({ status: "gagal", errorPesan: expect.stringContaining("Tidak ada perangkat") });
  });

  it("mengirim ke user penerima dengan isi pesan dari alert", async () => {
    queue(row());
    sendPush.mockResolvedValue(delivery({ ok: 1 }));
    await dispatchPending();
    expect(sendPush).toHaveBeenCalledWith(1, {
      title: "Peringatan: Detak jantung terlalu tinggi",
      body: "Detak jantung terlalu tinggi pada Bu Siti",
      data: { alertId: "5", elderId: "3", level: "tinggi", type: "Detak jantung terlalu tinggi" },
    });
  });
});

describe("ketahanan", () => {
  it("kegagalan tak terduga pada satu baris tidak menghentikan baris lain", async () => {
    queue(row({ id: 1n, channel: "dashboard" }), row({ id: 2n, channel: "dashboard" }));
    prismaMock.notification.update.mockRejectedValueOnce(new Error("db putus")).mockResolvedValue({});
    const stats = await dispatchPending();
    expect(prismaMock.notification.update).toHaveBeenCalledTimes(2);
    expect(stats.sent).toBe(1);
  });
});

describe("buildPayload", () => {
  it("judul memakai awalan 'Peringatan:' hanya untuk level tinggi", () => {
    expect(buildPayload(row({ tingkat: "tinggi" }) as any).title).toBe("Peringatan: Detak jantung terlalu tinggi");
    expect(buildPayload(row({ tingkat: "sedang" }) as any).title).toBe("Detak jantung terlalu tinggi");
  });
});
