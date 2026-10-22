-- AlterTable
ALTER TABLE "tb_kamera_cctv"
  ADD COLUMN "stream_host"     VARCHAR(255),
  ADD COLUMN "stream_port"     INTEGER,
  ADD COLUMN "stream_user"     VARCHAR(100),
  ADD COLUMN "stream_pass_enc" TEXT,
  ADD COLUMN "stream_path"     VARCHAR(255),
  ADD COLUMN "stream_fps"      DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "stream_enabled"  BOOLEAN NOT NULL DEFAULT false;
