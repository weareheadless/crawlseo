-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('O1_winnable_rank', 'O2_striking_distance', 'O3_content_gap', 'O4_aeo_citation_gap', 'O5_aeo_presence_gap', 'O6_business_fact_mismatch', 'O7_technical_defect', 'O8_structured_data_gap', 'O9_backlink_gap', 'O10_cannibalization', 'O11_freshness_decay', 'O12_page_experience', 'O13_user_pain_point', 'O14_offer_positioning_gap');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('detected', 'accepted', 'in_progress', 'parked', 'rejected', 'closed');

-- CreateEnum
CREATE TYPE "OpportunityDimension" AS ENUM ('seo', 'aeo', 'geo', 'content', 'technical');

-- CreateEnum
CREATE TYPE "EvidenceLeg" AS ENUM ('why', 'how', 'both', 'none');

-- CreateEnum
CREATE TYPE "EdgeEndpointType" AS ENUM ('raw_provider_response', 'evidence_record', 'opportunity', 'task', 'delivery', 'outcome_observation');

-- CreateEnum
CREATE TYPE "EdgeRelation" AS ENUM ('supporting', 'contradicting', 'baseline', 'produced_by', 'superseded_by', 'serves');

-- CreateEnum
CREATE TYPE "ClusterIntent" AS ENUM ('informational', 'commercial', 'transactional', 'local', 'mixed');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('todo', 'in_progress', 'awaiting_human', 'delivered', 'verified_outcome');

-- CreateEnum
CREATE TYPE "OutcomeVerdict" AS ENUM ('verified_win', 'no_effect', 'regression', 'unmeasured', 'pending');

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "OpportunityType" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'detected',
    "dimension" "OpportunityDimension" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "clusterId" TEXT,
    "scoreValue" INTEGER,
    "scoreInputs" JSONB NOT NULL,
    "evidenceCompleteness" "EvidenceLeg" NOT NULL DEFAULT 'none',
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detectedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "lastScoredAt" TIMESTAMP(3),
    "parkReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceEdge" (
    "id" TEXT NOT NULL,
    "fromType" "EdgeEndpointType" NOT NULL,
    "fromId" TEXT NOT NULL,
    "toType" "EdgeEndpointType" NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" "EdgeRelation" NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemandMapCluster" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "topicSummary" TEXT NOT NULL,
    "intent" "ClusterIntent" NOT NULL DEFAULT 'mixed',
    "businessRelevance" JSONB NOT NULL,
    "tracked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemandMapCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assignedTo" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'todo',
    "plan" JSONB,
    "agentPreparedById" TEXT,
    "humanConfirmedBy" TEXT,
    "humanConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Baseline" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Baseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutcomeObservation" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "baselineMetrics" JSONB NOT NULL,
    "baselineObservedAt" TIMESTAMP(3) NOT NULL,
    "afterMetrics" JSONB NOT NULL,
    "afterObservedAt" TIMESTAMP(3) NOT NULL,
    "verdict" "OutcomeVerdict" NOT NULL,
    "measuredBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutcomeObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Opportunity_projectId_status_idx" ON "Opportunity"("projectId", "status");

-- CreateIndex
CREATE INDEX "Opportunity_projectId_type_idx" ON "Opportunity"("projectId", "type");

-- CreateIndex
CREATE INDEX "Opportunity_clusterId_idx" ON "Opportunity"("clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_projectId_dedupKey_key" ON "Opportunity"("projectId", "dedupKey");

-- CreateIndex
CREATE INDEX "EvidenceEdge_toType_toId_idx" ON "EvidenceEdge"("toType", "toId");

-- CreateIndex
CREATE INDEX "EvidenceEdge_fromType_fromId_idx" ON "EvidenceEdge"("fromType", "fromId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceEdge_fromType_fromId_toType_toId_relation_key" ON "EvidenceEdge"("fromType", "fromId", "toType", "toId", "relation");

-- CreateIndex
CREATE INDEX "DemandMapCluster_projectId_idx" ON "DemandMapCluster"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "DemandMapCluster_projectId_slug_key" ON "DemandMapCluster"("projectId", "slug");

-- CreateIndex
CREATE INDEX "Task_opportunityId_idx" ON "Task"("opportunityId");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Baseline_taskId_idx" ON "Baseline"("taskId");

-- CreateIndex
CREATE INDEX "OutcomeObservation_taskId_idx" ON "OutcomeObservation"("taskId");

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "DemandMapCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandMapCluster" ADD CONSTRAINT "DemandMapCluster_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Baseline" ADD CONSTRAINT "Baseline_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeObservation" ADD CONSTRAINT "OutcomeObservation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

