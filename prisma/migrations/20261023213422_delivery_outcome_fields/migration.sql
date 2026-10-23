-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "outcome" JSONB,
ADD COLUMN     "outcomeMeasuredAt" TIMESTAMP(3);
