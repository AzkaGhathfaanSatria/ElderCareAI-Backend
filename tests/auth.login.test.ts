import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import { prismaMock, resetPrismaMock } from "./helpers/prismaMock";

jest.mock("../src/generated/prisma/client", () => ({ Prisma: {} })); // klien hasil generate memakai import.meta (khusus ESM)
jest.mock("../src/lib/prisma", () => ({ __esModule: true, default: require("./helpers/prismaMock").prismaMock }));

import app from "../src/app";

const PASSWORD = "rahasia123";
let hash: string;
beforeAll(async () => {
  hash = await bcrypt.hash(PASSWORD, 4);
});

const user = (over: object = {}) => ({ id: 7, nama: "Budi", email: "budi@contoh.id", password: hash, role: "keluarga", status: "aktif", ...over });

beforeEach(() => {
  resetPrismaMock();
  prismaMock.refreshToken.create.mockResolvedValue({});
});

describe("POST /auth/login", () => {
  it("200: kredensial benar -> access token valid + refresh token, tanpa hash password", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user());
    const res = await request(app).post("/auth/login").send({ email: "budi@contoh.id", password: PASSWORD });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.user).toEqual({ id: 7, nama: "Budi", email: "budi@contoh.id", role: "keluarga" });
    expect(jwt.verify(data.accessToken, process.env.JWT_SECRET!)).toMatchObject({ userId: 7, role: "keluarga" });
    expect(data.refreshToken).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toContain(hash);
    expect(prismaMock.refreshToken.create).toHaveBeenCalledTimes(1);
  });

  it("401: password salah", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user());
    const res = await request(app).post("/auth/login").send({ email: "budi@contoh.id", password: "salah" });
    expect(res.status).toBe(401);
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it("401: email tidak terdaftar, pesan sama dengan password salah (tidak membocorkan keberadaan akun)", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(user());
    const unknown = await request(app).post("/auth/login").send({ email: "x@contoh.id", password: PASSWORD });
    const wrong = await request(app).post("/auth/login").send({ email: "budi@contoh.id", password: "salah" });
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it("401: akun nonaktif tidak mendapat token", async () => {
    prismaMock.user.findUnique.mockResolvedValue(user({ status: "nonaktif" }));
    const res = await request(app).post("/auth/login").send({ email: "budi@contoh.id", password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  it("400: body tidak valid (email bukan format email / password kosong)", async () => {
    const bad = await request(app).post("/auth/login").send({ email: "bukan-email", password: PASSWORD });
    const empty = await request(app).post("/auth/login").send({ email: "budi@contoh.id" });
    expect(bad.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /auth/me", () => {
  it("401 tanpa token", async () => {
    expect((await request(app).get("/auth/me")).status).toBe(401);
  });
});
