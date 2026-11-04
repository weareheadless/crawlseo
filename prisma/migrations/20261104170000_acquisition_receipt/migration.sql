-- Additive: durable record of each paid-acquisition pass.
CREATE TABLE "AcquisitionReceipt" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteId" TEXT,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "requested" INTEGER NOT NULL DEFAULT 0,
    "measured" INTEGER NOT NULL DEFAULT 0,
    "noData" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "cached" INTEGER NOT NULL DEFAULT 0,
    "spentMicros" INTEGER NOT NULL DEFAULT 0,
    "requests" JSONB NOT NULL,
    "skipped" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AcquisitionReceipt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AcquisitionReceipt_projectId_createdAt_idx" ON "AcquisitionReceipt"("projectId", "createdAt");
ALTER TABLE "AcquisitionReceipt" ADD CONSTRAINT "AcquisitionReceipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
