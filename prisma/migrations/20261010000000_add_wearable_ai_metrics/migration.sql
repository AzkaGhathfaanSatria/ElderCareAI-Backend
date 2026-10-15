-- AlterTable
ALTER TABLE "tb_data_wearable" ADD COLUMN     "acceleration_magnitude" DOUBLE PRECISION,
ADD COLUMN     "gyro_magnitude" DOUBLE PRECISION,
ADD COLUMN     "heart_rate_variability" DOUBLE PRECISION,
ADD COLUMN     "oxygen_level" DOUBLE PRECISION,
ADD COLUMN     "temperature" DOUBLE PRECISION;
