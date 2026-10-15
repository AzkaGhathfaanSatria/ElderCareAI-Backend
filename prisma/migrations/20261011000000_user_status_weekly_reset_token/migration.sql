-- AlterTable
ALTER TABLE "tb_user" ADD COLUMN     "status" VARCHAR(20) NOT NULL DEFAULT 'aktif';

-- AlterTable
ALTER TABLE "tb_preferensi_notifikasi" ADD COLUMN     "weekly_summary" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "tb_reset_password_token" (
    "id_reset_token" BIGSERIAL NOT NULL,
    "id_user" INTEGER NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tb_reset_password_token_pkey" PRIMARY KEY ("id_reset_token")
);

-- CreateIndex
CREATE UNIQUE INDEX "tb_reset_password_token_token_hash_key" ON "tb_reset_password_token"("token_hash");

-- CreateIndex
CREATE INDEX "tb_reset_password_token_id_user_created_at_idx" ON "tb_reset_password_token"("id_user", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "tb_reset_password_token" ADD CONSTRAINT "tb_reset_password_token_id_user_fkey" FOREIGN KEY ("id_user") REFERENCES "tb_user"("id_user") ON DELETE RESTRICT ON UPDATE CASCADE;
