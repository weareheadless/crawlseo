ALTER TABLE "ContentDraft"
ADD COLUMN "wixApprovalHash" TEXT,
ADD COLUMN "wixApprovedBy" TEXT,
ADD COLUMN "wixApprovedAt" TIMESTAMP(3),
ADD COLUMN "wixApprovedRevision" INTEGER;
