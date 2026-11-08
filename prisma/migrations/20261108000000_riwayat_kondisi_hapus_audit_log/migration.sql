-- Hapus tabel yang tidak dipakai (tidak ada kode yang menulis/membacanya).
DROP TABLE "tb_audit_log";

-- Riwayat kondisi lansia per periode.
CREATE TABLE "tb_riwayat_kondisi" (
    "id_riwayat" BIGSERIAL NOT NULL,
    "id_lansia" INTEGER NOT NULL,
    "waktu" TIMESTAMPTZ(6) NOT NULL,
    "periode_menit" INTEGER NOT NULL DEFAULT 15,
    "status" VARCHAR(20) NOT NULL,
    "data_jam_ada" BOOLEAN NOT NULL DEFAULT false,
    "detak_rata" DOUBLE PRECISION,
    "detak_min" INTEGER,
    "detak_maks" INTEGER,
    "spo2_rata" DOUBLE PRECISION,
    "suhu_rata" DOUBLE PRECISION,
    "hrv_rata" DOUBLE PRECISION,
    "skor_risiko" DOUBLE PRECISION,
    "level_risiko" VARCHAR(30),
    "deteksi_kamera" INTEGER NOT NULL DEFAULT 0,
    "jatuh_terdeteksi" BOOLEAN NOT NULL DEFAULT false,
    "jumlah_alert" INTEGER NOT NULL DEFAULT 0,
    "ringkasan" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_riwayat_kondisi_pkey" PRIMARY KEY ("id_riwayat")
);

-- CreateIndex
CREATE INDEX "tb_riwayat_kondisi_id_lansia_waktu_idx" ON "tb_riwayat_kondisi"("id_lansia", "waktu" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tb_riwayat_kondisi_id_lansia_waktu_key" ON "tb_riwayat_kondisi"("id_lansia", "waktu");

-- AddForeignKey
ALTER TABLE "tb_riwayat_kondisi" ADD CONSTRAINT "tb_riwayat_kondisi_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE CASCADE ON UPDATE CASCADE;
