import prisma from "../../lib/prisma";

export async function getElders(
  userId: number,
  role: "admin" | "keluarga" | "tenaga_medis"
) {
  if (role === "tenaga_medis") {
    return [];
  }

  const where =
    role === "admin"
      ? {}
      : {
          idUserKeluarga: userId,
        };

  return prisma.lansia.findMany({
    where,
    select: {
      id: true,
      idUserKeluarga: true,
      nama: true,
      tanggalLahir: true,
      alamat: true,
      catatanKesehatan: true,
    },
    orderBy: {
      id: "desc",
    },
  });
}