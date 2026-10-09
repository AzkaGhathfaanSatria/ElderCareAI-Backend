-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'keluarga', 'tenaga_medis');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('aktif', 'nonaktif');

-- CreateEnum
CREATE TYPE "SensorType" AS ENUM ('gerak', 'pintu');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('rendah', 'sedang', 'tinggi');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('baru', 'ditindaklanjuti', 'selesai');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('dashboard', 'push', 'whatsapp', 'email');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('terkirim', 'gagal', 'pending');

-- CreateTable
CREATE TABLE "tb_user" (
    "id_user" SERIAL NOT NULL,
    "nama" VARCHAR(100) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'keluarga',
    "no_telepon" VARCHAR(20),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_user_pkey" PRIMARY KEY ("id_user")
);

-- CreateTable
CREATE TABLE "tb_lansia" (
    "id_lansia" SERIAL NOT NULL,
    "id_user_keluarga" INTEGER NOT NULL,
    "nama" VARCHAR(100) NOT NULL,
    "tanggal_lahir" DATE NOT NULL,
    "alamat" VARCHAR(255) NOT NULL,
    "catatan_kesehatan" TEXT,

    CONSTRAINT "tb_lansia_pkey" PRIMARY KEY ("id_lansia")
);

-- CreateTable
CREATE TABLE "tb_wearable" (
    "id_wearable" SERIAL NOT NULL,
    "id_lansia" INTEGER NOT NULL,
    "tipe_perangkat" VARCHAR(50) NOT NULL,
    "status_baterai" INTEGER NOT NULL DEFAULT 100,
    "tanggal_pairing" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "device_key_hash" VARCHAR(255),
    "last_seen" TIMESTAMPTZ(6),

    CONSTRAINT "tb_wearable_pkey" PRIMARY KEY ("id_wearable")
);

-- CreateTable
CREATE TABLE "tb_sensor_iot" (
    "id_sensor" SERIAL NOT NULL,
    "id_lansia" INTEGER NOT NULL,
    "tipe_sensor" "SensorType" NOT NULL,
    "lokasi_pemasangan" VARCHAR(100) NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'aktif',

    CONSTRAINT "tb_sensor_iot_pkey" PRIMARY KEY ("id_sensor")
);

-- CreateTable
CREATE TABLE "tb_vital_sign" (
    "id_vital" BIGSERIAL NOT NULL,
    "id_wearable" INTEGER NOT NULL,
    "detak_jantung" INTEGER,
    "pola_tidur" JSONB,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_vital_sign_pkey" PRIMARY KEY ("id_vital")
);

-- CreateTable
CREATE TABLE "tb_data_aktivitas" (
    "id_aktivitas" BIGSERIAL NOT NULL,
    "id_sensor" INTEGER NOT NULL,
    "jenis_aktivitas" VARCHAR(100) NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_data_aktivitas_pkey" PRIMARY KEY ("id_aktivitas")
);

-- CreateTable
CREATE TABLE "tb_data_wearable" (
    "id_data" BIGSERIAL NOT NULL,
    "id_wearable" INTEGER NOT NULL,
    "detak_jantung" INTEGER,
    "pola_tidur" JSONB,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_data_wearable_pkey" PRIMARY KEY ("id_data")
);

-- CreateTable
CREATE TABLE "tb_baseline_perilaku" (
    "id_baseline" SERIAL NOT NULL,
    "id_lansia" INTEGER NOT NULL,
    "pola_normal" JSONB NOT NULL,
    "versi_model" VARCHAR(50) NOT NULL,
    "tanggal_dibentuk" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_baseline_perilaku_pkey" PRIMARY KEY ("id_baseline")
);

-- CreateTable
CREATE TABLE "tb_prediksi_risiko_jatuh" (
    "id_prediksi" BIGSERIAL NOT NULL,
    "id_lansia" INTEGER NOT NULL,
    "id_baseline" INTEGER,
    "skor_risiko" DOUBLE PRECISION NOT NULL,
    "level_risiko" VARCHAR(30) NOT NULL,
    "waktu_prediksi" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_prediksi_risiko_jatuh_pkey" PRIMARY KEY ("id_prediksi")
);

-- CreateTable
CREATE TABLE "tb_kamera_cctv" (
    "id_kamera" SERIAL NOT NULL,
    "id_lansia" INTEGER NOT NULL,
    "nama_kamera" VARCHAR(100) NOT NULL,
    "lokasi" VARCHAR(100) NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'aktif',
    "last_seen" TIMESTAMPTZ(6),

    CONSTRAINT "tb_kamera_cctv_pkey" PRIMARY KEY ("id_kamera")
);

-- CreateTable
CREATE TABLE "tb_deteksi_yolo" (
    "id_deteksi" BIGSERIAL NOT NULL,
    "id_kamera" INTEGER,
    "id_lansia" INTEGER NOT NULL,
    "kelas" VARCHAR(50) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "bbox" JSONB,
    "keypoints" JSONB,
    "versi_model" VARCHAR(50),
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_deteksi_yolo_pkey" PRIMARY KEY ("id_deteksi")
);

-- CreateTable
CREATE TABLE "tb_kejadian_jatuh" (
    "id_jatuh" BIGSERIAL NOT NULL,
    "id_lansia" INTEGER NOT NULL,
    "id_deteksi" BIGINT,
    "waktu_kejadian" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "konfirmasi" BOOLEAN,
    "false_alarm" BOOLEAN,

    CONSTRAINT "tb_kejadian_jatuh_pkey" PRIMARY KEY ("id_jatuh")
);

-- CreateTable
CREATE TABLE "tb_alert" (
    "id_alert" BIGSERIAL NOT NULL,
    "id_lansia" INTEGER NOT NULL,
    "id_baseline" INTEGER,
    "id_prediksi" BIGINT,
    "id_jatuh" BIGINT,
    "jenis_anomali" VARCHAR(100) NOT NULL,
    "tingkat_keparahan" "AlertSeverity" NOT NULL,
    "waktu_deteksi" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "AlertStatus" NOT NULL DEFAULT 'baru',
    "dedup_key" VARCHAR(255),

    CONSTRAINT "tb_alert_pkey" PRIMARY KEY ("id_alert")
);

-- CreateTable
CREATE TABLE "tb_notifikasi" (
    "id_notifikasi" BIGSERIAL NOT NULL,
    "id_alert" BIGINT NOT NULL,
    "id_user_penerima" INTEGER NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "waktu_kirim" TIMESTAMPTZ(6),
    "status_baca" BOOLEAN NOT NULL DEFAULT false,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "percobaan_ke" INTEGER NOT NULL DEFAULT 0,
    "error_pesan" TEXT,

    CONSTRAINT "tb_notifikasi_pkey" PRIMARY KEY ("id_notifikasi")
);

-- CreateTable
CREATE TABLE "tb_izin_akses" (
    "id_izin" SERIAL NOT NULL,
    "id_lansia" INTEGER NOT NULL,
    "id_user_medis" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'aktif',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "tb_izin_akses_pkey" PRIMARY KEY ("id_izin")
);

-- CreateTable
CREATE TABLE "tb_preferensi_notifikasi" (
    "id_preferensi" SERIAL NOT NULL,
    "id_user" INTEGER NOT NULL,
    "dashboard" BOOLEAN NOT NULL DEFAULT true,
    "push" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "level_minimum" VARCHAR(20) NOT NULL DEFAULT 'sedang',

    CONSTRAINT "tb_preferensi_notifikasi_pkey" PRIMARY KEY ("id_preferensi")
);

-- CreateTable
CREATE TABLE "tb_token_push" (
    "id_token" SERIAL NOT NULL,
    "id_user" INTEGER NOT NULL,
    "token" VARCHAR(500) NOT NULL,
    "platform" VARCHAR(30),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_token_push_pkey" PRIMARY KEY ("id_token")
);

-- CreateTable
CREATE TABLE "tb_refresh_token" (
    "id_refresh_token" BIGSERIAL NOT NULL,
    "id_user" INTEGER NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_refresh_token_pkey" PRIMARY KEY ("id_refresh_token")
);

-- CreateTable
CREATE TABLE "tb_audit_log" (
    "id_audit" BIGSERIAL NOT NULL,
    "id_user" INTEGER,
    "id_lansia" INTEGER,
    "action" VARCHAR(100) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_audit_log_pkey" PRIMARY KEY ("id_audit")
);

-- CreateIndex
CREATE UNIQUE INDEX "tb_user_email_key" ON "tb_user"("email");

-- CreateIndex
CREATE INDEX "tb_vital_sign_id_wearable_timestamp_idx" ON "tb_vital_sign"("id_wearable", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "tb_data_aktivitas_id_sensor_timestamp_idx" ON "tb_data_aktivitas"("id_sensor", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "tb_data_wearable_id_wearable_timestamp_idx" ON "tb_data_wearable"("id_wearable", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tb_data_wearable_id_wearable_timestamp_key" ON "tb_data_wearable"("id_wearable", "timestamp");

-- CreateIndex
CREATE INDEX "tb_deteksi_yolo_id_lansia_timestamp_idx" ON "tb_deteksi_yolo"("id_lansia", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tb_alert_dedup_key_key" ON "tb_alert"("dedup_key");

-- CreateIndex
CREATE INDEX "tb_alert_id_lansia_waktu_deteksi_idx" ON "tb_alert"("id_lansia", "waktu_deteksi" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tb_izin_akses_id_lansia_id_user_medis_key" ON "tb_izin_akses"("id_lansia", "id_user_medis");

-- CreateIndex
CREATE UNIQUE INDEX "tb_preferensi_notifikasi_id_user_key" ON "tb_preferensi_notifikasi"("id_user");

-- CreateIndex
CREATE UNIQUE INDEX "tb_token_push_token_key" ON "tb_token_push"("token");

-- CreateIndex
CREATE INDEX "tb_audit_log_created_at_idx" ON "tb_audit_log"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "tb_lansia" ADD CONSTRAINT "tb_lansia_id_user_keluarga_fkey" FOREIGN KEY ("id_user_keluarga") REFERENCES "tb_user"("id_user") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_wearable" ADD CONSTRAINT "tb_wearable_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_sensor_iot" ADD CONSTRAINT "tb_sensor_iot_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_vital_sign" ADD CONSTRAINT "tb_vital_sign_id_wearable_fkey" FOREIGN KEY ("id_wearable") REFERENCES "tb_wearable"("id_wearable") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_data_aktivitas" ADD CONSTRAINT "tb_data_aktivitas_id_sensor_fkey" FOREIGN KEY ("id_sensor") REFERENCES "tb_sensor_iot"("id_sensor") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_data_wearable" ADD CONSTRAINT "tb_data_wearable_id_wearable_fkey" FOREIGN KEY ("id_wearable") REFERENCES "tb_wearable"("id_wearable") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_baseline_perilaku" ADD CONSTRAINT "tb_baseline_perilaku_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_prediksi_risiko_jatuh" ADD CONSTRAINT "tb_prediksi_risiko_jatuh_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_prediksi_risiko_jatuh" ADD CONSTRAINT "tb_prediksi_risiko_jatuh_id_baseline_fkey" FOREIGN KEY ("id_baseline") REFERENCES "tb_baseline_perilaku"("id_baseline") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_kamera_cctv" ADD CONSTRAINT "tb_kamera_cctv_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_deteksi_yolo" ADD CONSTRAINT "tb_deteksi_yolo_id_kamera_fkey" FOREIGN KEY ("id_kamera") REFERENCES "tb_kamera_cctv"("id_kamera") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_kejadian_jatuh" ADD CONSTRAINT "tb_kejadian_jatuh_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_kejadian_jatuh" ADD CONSTRAINT "tb_kejadian_jatuh_id_deteksi_fkey" FOREIGN KEY ("id_deteksi") REFERENCES "tb_deteksi_yolo"("id_deteksi") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_alert" ADD CONSTRAINT "tb_alert_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_alert" ADD CONSTRAINT "tb_alert_id_baseline_fkey" FOREIGN KEY ("id_baseline") REFERENCES "tb_baseline_perilaku"("id_baseline") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_alert" ADD CONSTRAINT "tb_alert_id_prediksi_fkey" FOREIGN KEY ("id_prediksi") REFERENCES "tb_prediksi_risiko_jatuh"("id_prediksi") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_alert" ADD CONSTRAINT "tb_alert_id_jatuh_fkey" FOREIGN KEY ("id_jatuh") REFERENCES "tb_kejadian_jatuh"("id_jatuh") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_notifikasi" ADD CONSTRAINT "tb_notifikasi_id_alert_fkey" FOREIGN KEY ("id_alert") REFERENCES "tb_alert"("id_alert") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_notifikasi" ADD CONSTRAINT "tb_notifikasi_id_user_penerima_fkey" FOREIGN KEY ("id_user_penerima") REFERENCES "tb_user"("id_user") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_izin_akses" ADD CONSTRAINT "tb_izin_akses_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_refresh_token" ADD CONSTRAINT "tb_refresh_token_id_user_fkey" FOREIGN KEY ("id_user") REFERENCES "tb_user"("id_user") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_audit_log" ADD CONSTRAINT "tb_audit_log_id_user_fkey" FOREIGN KEY ("id_user") REFERENCES "tb_user"("id_user") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tb_audit_log" ADD CONSTRAINT "tb_audit_log_id_lansia_fkey" FOREIGN KEY ("id_lansia") REFERENCES "tb_lansia"("id_lansia") ON DELETE SET NULL ON UPDATE CASCADE;
