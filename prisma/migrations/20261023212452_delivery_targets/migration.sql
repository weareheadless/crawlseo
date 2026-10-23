-- CreateTable
CREATE TABLE "DeliveryTarget" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "componentTag" TEXT,
    "snippetId" TEXT,
    "sourcePath" TEXT,
    "route" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryTarget_siteId_adapter_idx" ON "DeliveryTarget"("siteId", "adapter");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTarget_siteId_key_key" ON "DeliveryTarget"("siteId", "key");

-- AddForeignKey
ALTER TABLE "DeliveryTarget" ADD CONSTRAINT "DeliveryTarget_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
