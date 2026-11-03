-- CreateEnum
CREATE TYPE "EvidenceRecordKind" AS ENUM ('keyword_rank', 'keyword_metrics', 'serp_snapshot', 'serp_features', 'intent_label', 'competitor_rank', 'backlink_profile', 'share_of_voice', 'keyword_universe_membership', 'onpage_crawl', 'internal_link_graph', 'ai_visibility_observation', 'gsc_query', 'gsc_page', 'vitals', 'analytics', 'knowledge_fact', 'question_coverage', 'research_finding');

-- CreateTable
CREATE TABLE "RawProviderResponse" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "providerTaskId" TEXT,
    "locale" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "costMicros" BIGINT,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawProviderResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceRecord" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteId" TEXT,
    "kind" "EvidenceRecordKind" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "producer" TEXT NOT NULL,
    "rawResponseId" TEXT,
    "dimensions" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "observationHash" TEXT NOT NULL,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawProviderResponse_provider_product_requestedAt_idx" ON "RawProviderResponse"("provider", "product", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawProviderResponse_provider_providerTaskId_key" ON "RawProviderResponse"("provider", "providerTaskId");

-- CreateIndex
CREATE INDEX "EvidenceRecord_projectId_kind_observedAt_idx" ON "EvidenceRecord"("projectId", "kind", "observedAt");

-- CreateIndex
CREATE INDEX "EvidenceRecord_projectId_siteId_idx" ON "EvidenceRecord"("projectId", "siteId");

-- CreateIndex
CREATE INDEX "EvidenceRecord_supersededById_idx" ON "EvidenceRecord"("supersededById");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceRecord_projectId_kind_observationHash_key" ON "EvidenceRecord"("projectId", "kind", "observationHash");

-- AddForeignKey
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_rawResponseId_fkey" FOREIGN KEY ("rawResponseId") REFERENCES "RawProviderResponse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "EvidenceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

