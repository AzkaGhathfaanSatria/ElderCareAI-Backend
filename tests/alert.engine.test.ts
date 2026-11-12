import { prismaMock, resetPrismaMock } from "./helpers/prismaMock";

jest.mock("../src/lib/prisma", () => ({ __esModule: true, default: require("./helpers/prismaMock").prismaMock }));
jest.mock("../src/common/events", () => ({ publish: jest.fn() }));
jest.mock("../src/integrations/aiClient", () => ({ inferSensor: jest.fn() }));
jest.mock("../src/modules/baseline/baseline.service", () => ({ latestBaseline: jest.fn() }));
jest.mock("../src/modules/notifications/outbox", () => ({ kickOutbox: jest.fn() }));

import { publish } from "../src/common/events";
import { evaluateWearable, planRecipients } from "../src/modules/alerts/alert.engine";
import { kickOutbox } from "../src/modules/notifications/outbox";

const COOLDOWN_MS = 30 * 60_000; // ALERT_COOLDOWN_MIN default
const hr = (...values: number[]) => values.map((detakJantung) => ({ detakJantung }));

function setup({ readings, grants = [], prefs = [] }: { readings: { detakJantung: number }[]; grants?: { idUserMedis: number }[]; prefs?: object[] }) {
  prismaMock.vitalSign.findMany.mockResolvedValue(readings);
  prismaMock.alert.create.mockResolvedValue({ id: 1n });
  prismaMock.lansia.findUnique.mockResolvedValue({ idUserKeluarga: 1, nama: "Bu Siti" });
  prismaMock.accessGrant.findMany.mockResolvedValue(grants);
  prismaMock.notificationPreference.findMany.mockResolvedValue(prefs);
  prismaMock.notification.createMany.mockResolvedValue({ count: 0 });
}

const alertData = (call = 0) => prismaMock.alert.create.mock.calls[call][0].data;
const notifRows = () => prismaMock.notification.createMany.mock.calls[0][0].data as Array<{ idUserPenerima: number; channel: string; status: string }>;

beforeEach(() => {
  resetPrismaMock();
  jest.restoreAllMocks();
});

describe("ambang detak jantung (evaluateWearable)", () => {
  it("tidak membuat alert bila pembacaan kurang dari 3", async () => {
    setup({ readings: hr(150, 150) });
    expect(await evaluateWearable(1, 1)).toBeNull();
    expect(prismaMock.alert.create).not.toHaveBeenCalled();
  });

  it("alert 'sedang' bila 3 pembacaan berturut-turut di atas 120 tetapi tidak semuanya di atas 140", async () => {
    setup({ readings: hr(130, 125, 150) });
    await evaluateWearable(1, 1);
    expect(alertData()).toMatchObject({ idLansia: 1, jenisAnomali: "Detak jantung terlalu tinggi", tingkatKeparahan: "sedang" });
  });

  it("alert 'tinggi' (kritis) bila ketiganya di atas 140", async () => {
    setup({ readings: hr(145, 150, 160) });
    await evaluateWearable(1, 1);
    expect(alertData().tingkatKeparahan).toBe("tinggi");
  });

  it("detak rendah: di bawah 45 = sedang, di bawah 40 = tinggi", async () => {
    setup({ readings: hr(44, 43, 42) });
    await evaluateWearable(1, 1);
    expect(alertData()).toMatchObject({ jenisAnomali: "Detak jantung terlalu rendah", tingkatKeparahan: "sedang" });

    resetPrismaMock();
    setup({ readings: hr(39, 38, 35) });
    await evaluateWearable(1, 1);
    expect(alertData().tingkatKeparahan).toBe("tinggi");
  });

  it("nilai tepat di ambang tidak memicu alert (perbandingan ketat)", async () => {
    setup({ readings: hr(120, 120, 120) });
    expect(await evaluateWearable(1, 1)).toBeNull();
    setup({ readings: hr(45, 45, 45) });
    expect(await evaluateWearable(1, 1)).toBeNull();
    expect(prismaMock.alert.create).not.toHaveBeenCalled();
  });

  it("satu pembacaan normal di tengah membatalkan alert", async () => {
    setup({ readings: hr(150, 80, 150) });
    expect(await evaluateWearable(1, 1)).toBeNull();
    expect(prismaMock.alert.create).not.toHaveBeenCalled();
  });
});

describe("dedup dan cooldown", () => {
  it("alert yang sama dalam cooldown (P2002) menghasilkan null tanpa notifikasi, kick, atau event", async () => {
    setup({ readings: hr(150, 150, 150) });
    prismaMock.alert.create.mockRejectedValue(Object.assign(new Error("Unique constraint"), { code: "P2002" }));

    expect(await evaluateWearable(1, 1)).toBeNull();
    expect(prismaMock.notification.createMany).not.toHaveBeenCalled();
    expect(kickOutbox).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("error selain P2002 dilempar ulang", async () => {
    setup({ readings: hr(150, 150, 150) });
    prismaMock.alert.create.mockRejectedValue(new Error("koneksi putus"));
    await expect(evaluateWearable(1, 1)).rejects.toThrow("koneksi putus");
    expect(kickOutbox).not.toHaveBeenCalled();
  });

  it("dedupKey sama di dalam satu jendela cooldown, berbeda setelahnya, dan berbeda untuk tinggi vs rendah", async () => {
    const start = Math.floor(1_800_000_000_000 / COOLDOWN_MS) * COOLDOWN_MS; // awal jendela
    const now = jest.spyOn(Date, "now");

    setup({ readings: hr(150, 150, 150) });
    now.mockReturnValue(start + 1_000);
    await evaluateWearable(1, 1);
    now.mockReturnValue(start + 10 * 60_000);
    await evaluateWearable(1, 1);
    now.mockReturnValue(start + COOLDOWN_MS + 1_000);
    await evaluateWearable(1, 1);

    expect(alertData(0).dedupKey).toBe(alertData(1).dedupKey);
    expect(alertData(2).dedupKey).not.toBe(alertData(0).dedupKey);

    prismaMock.vitalSign.findMany.mockResolvedValue(hr(40, 40, 40));
    now.mockReturnValue(start + 1_000);
    await evaluateWearable(1, 1);
    expect(alertData(3).dedupKey).not.toBe(alertData(0).dedupKey);
    expect(alertData(3).dedupKey).toContain(":low:");
    expect(alertData(0).dedupKey).toContain(":high:");
  });
});

describe("alert + notifikasi dalam satu transaksi", () => {
  it("membuat alert dan semua baris notifikasi 'pending' (dashboard + push) lewat transaksi yang sama", async () => {
    setup({ readings: hr(150, 150, 150), grants: [{ idUserMedis: 2 }] });
    await evaluateWearable(1, 1);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const rows = notifRows();
    expect(rows).toHaveLength(4); // 2 user x 2 kanal
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.filter((r) => r.channel === "dashboard").map((r) => r.idUserPenerima).sort()).toEqual([1, 2]);
    expect(rows.filter((r) => r.channel === "push").map((r) => r.idUserPenerima).sort()).toEqual([1, 2]);
    expect(kickOutbox).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(1, "alert", expect.objectContaining({ level: "tinggi" }));
  });

  it("bila pembuatan notifikasi gagal, error naik dan tidak ada kick/event (transaksi dibatalkan)", async () => {
    setup({ readings: hr(150, 150, 150) });
    prismaMock.notification.createMany.mockRejectedValue(new Error("disk penuh"));
    await expect(evaluateWearable(1, 1)).rejects.toThrow("disk penuh");
    expect(kickOutbox).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("penerima dan filter level (planRecipients)", () => {
  it("default level minimum 'sedang': 'rendah' tidak diberi tahu, 'sedang' dan 'tinggi' ya", async () => {
    setup({ readings: [] });
    expect(await planRecipients(1, "rendah")).toEqual([]);
    expect((await planRecipients(1, "sedang")).map((r) => r.userId)).toEqual([1]);
    expect((await planRecipients(1, "tinggi")).map((r) => r.userId)).toEqual([1]);
  });

  it("user dengan level minimum 'tinggi' tidak menerima alert 'sedang', tetapi menerima 'tinggi'", async () => {
    setup({ readings: [], grants: [{ idUserMedis: 2 }], prefs: [{ idUser: 2, levelMinimum: "tinggi", dashboard: true, push: true }] });
    expect((await planRecipients(1, "sedang")).map((r) => r.userId)).toEqual([1]);
    expect((await planRecipients(1, "tinggi")).map((r) => r.userId).sort()).toEqual([1, 2]);
  });

  it("preferensi kanal dihormati: dashboard/push dimatikan per user", async () => {
    setup({ readings: [], prefs: [{ idUser: 1, levelMinimum: "sedang", dashboard: false, push: true }] });
    expect(await planRecipients(1, "tinggi")).toEqual([{ userId: 1, dashboard: false, push: true }]);

    setup({ readings: [], prefs: [{ idUser: 1, levelMinimum: "sedang", dashboard: true, push: false }] });
    expect(await planRecipients(1, "tinggi")).toEqual([{ userId: 1, dashboard: true, push: false }]);
  });

  it("keluarga yang juga punya izin akses tidak digandakan", async () => {
    setup({ readings: [], grants: [{ idUserMedis: 1 }, { idUserMedis: 2 }] });
    expect((await planRecipients(1, "tinggi")).map((r) => r.userId).sort()).toEqual([1, 2]);
  });

  it("hanya izin akses yang aktif dan belum kedaluwarsa dicari", async () => {
    setup({ readings: [] });
    await planRecipients(1, "tinggi");
    const where = prismaMock.accessGrant.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ idLansia: 1, status: "aktif" });
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it("lansia tidak ditemukan: tidak ada penerima", async () => {
    setup({ readings: [] });
    prismaMock.lansia.findUnique.mockResolvedValue(null);
    expect(await planRecipients(99, "tinggi")).toEqual([]);
  });
});
