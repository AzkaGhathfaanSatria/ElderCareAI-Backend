/**
 * Buat akun admin, atau naikkan akun yang sudah ada menjadi admin.
 *   npm run create-admin -- email@contoh.com "PasswordMin8" "Nama Admin"
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import prisma from "../src/lib/prisma";

const [email, password, nama = "Admin"] = process.argv.slice(2);

async function main() {
  if (!email || !password) {
    console.error('Pemakaian: npm run create-admin -- email "password" "Nama"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password minimal 8 karakter.");
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { role: "admin", password: hash, status: "aktif" },
    create: { nama, email, password: hash, role: "admin" },
  });
  console.log(`Admin siap: ${user.email} (id ${user.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
