import "dotenv/config";
import bcrypt from "bcryptjs";
import prisma from "../src/lib/prisma";

if (process.env.NODE_ENV === "production") {
  console.error("Ditolak: seed akun demo tidak boleh dijalankan di production.");
  process.exit(1);
}

const accounts = [
  {
    nama: "Admin ElderCare",
    email: "admin@eldercare.ai",
    password: process.env.SEED_ADMIN_PASSWORD ?? "Admin#12345",
    role: "admin" as const,
  },
  {
    nama: "Dian Keluarga",
    email: "dian@eldercare.ai",
    password: process.env.SEED_KELUARGA_PASSWORD ?? "Keluarga#12345",
    role: "keluarga" as const,
  },
  {
    nama: "dr. Amelia",
    email: "amelia@eldercare.ai",
    password: process.env.SEED_MEDIS_PASSWORD ?? "Medis#12345",
    role: "tenaga_medis" as const,
  },
];

async function main() {
  for (const a of accounts) {
    const hash = await bcrypt.hash(a.password, 10);
    const user = await prisma.user.upsert({
      where: { email: a.email },
      update: { nama: a.nama, role: a.role, password: hash, status: "aktif" },
      create: { nama: a.nama, email: a.email, password: hash, role: a.role },
    });
    console.log(`${a.role.padEnd(13)} ${user.email}  (id ${user.id})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());