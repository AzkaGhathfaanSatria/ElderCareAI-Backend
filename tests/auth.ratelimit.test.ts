import request from "supertest";
import { prismaMock, resetPrismaMock } from "./helpers/prismaMock";

// Dibaca saat modul rute dimuat, jadi harus diset sebelum import app (tiap file test punya registri modul sendiri).
process.env.AUTH_LOGIN_MAX = "3";
jest.mock("../src/generated/prisma/client", () => ({ Prisma: {} })); // klien hasil generate memakai import.meta (khusus ESM)
jest.mock("../src/lib/prisma", () => ({ __esModule: true, default: require("./helpers/prismaMock").prismaMock }));

const app = require("../src/app").default;

beforeEach(() => {
  resetPrismaMock();
  prismaMock.user.findUnique.mockResolvedValue(null);
});

describe("pembatas login", () => {
  it("percobaan ke-4 dari IP yang sama ditolak 429 dengan header Retry-After", async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).post("/auth/login").send({ email: "a@contoh.id", password: "x" });
      expect(ok.status).toBe(401);
    }
    const blocked = await request(app).post("/auth/login").send({ email: "a@contoh.id", password: "x" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(3); // permintaan ke-4 tidak sampai ke database
  });
});
