-- Reversible: restore the table exactly as Prisma generated it before the drop.
CREATE TABLE "RankSnapshot" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RankSnapshot_siteId_query_date_key" ON "RankSnapshot"("siteId", "query", "date");
CREATE INDEX "RankSnapshot_siteId_date_idx" ON "RankSnapshot"("siteId", "date");
CREATE INDEX "RankSnapshot_siteId_query_idx" ON "RankSnapshot"("siteId", "query");

ALTER TABLE "RankSnapshot" ADD CONSTRAINT "RankSnapshot_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
