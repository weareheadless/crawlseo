-- CreateEnum
CREATE TYPE "AIVisibilitySourceKind" AS ENUM ('provider_export', 'provider_api', 'operator_manual');

-- CreateTable
CREATE TABLE "AIVisibilityObservation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelSurface" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "questionSetVersion" TEXT NOT NULL,
    "sourceKind" "AIVisibilitySourceKind" NOT NULL,
    "rawExportReference" TEXT NOT NULL,
    "denominator" INTEGER NOT NULL,
    "coverage" JSONB NOT NULL,
    "mentions" JSONB,
    "recommendations" JSONB,
    "citations" JSONB,
    "observationHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIVisibilityObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIVisibilityObservation_projectId_provider_observedAt_idx" ON "AIVisibilityObservation"("projectId", "provider", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AIVisibilityObservation_version_key" ON "AIVisibilityObservation"("projectId", "question", "provider", "modelSurface", "questionSetVersion", "observedAt", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AIVisibilityObservation_hash_key" ON "AIVisibilityObservation"("projectId", "question", "provider", "modelSurface", "questionSetVersion", "observedAt", "observationHash");

-- AddForeignKey
ALTER TABLE "AIVisibilityObservation" ADD CONSTRAINT "AIVisibilityObservation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

