/** Pengganti klien Prisma untuk test: hanya method yang dipakai kode yang diuji. */
const fn = () => jest.fn();

export const prismaMock = {
  vitalSign: { findMany: fn() },
  alert: { create: fn() },
  notification: { createMany: fn(), findMany: fn(), updateMany: fn(), update: fn() },
  lansia: { findUnique: fn() },
  accessGrant: { findMany: fn() },
  notificationPreference: { findMany: fn() },
  pushToken: { findMany: fn(), deleteMany: fn() },
  user: { findUnique: fn() },
  refreshToken: { create: fn() },
  $transaction: fn(),
};

/** Kosongkan semua mock dan pulihkan perilaku bawaan ($transaction menjalankan callback dengan mock yang sama). */
export function resetPrismaMock() {
  for (const value of Object.values(prismaMock)) {
    if (typeof value === "function") (value as jest.Mock).mockReset();
    else for (const m of Object.values(value)) (m as jest.Mock).mockReset();
  }
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock));
}
