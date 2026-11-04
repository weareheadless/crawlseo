-- A site record that must survive for audit but must not be analysed any more.
-- Some records cannot be deleted: a completed legacy-budget migration leaves an
-- immutable receipt pointing at the source site, so the row is the audit anchor
-- for that transfer. Retiring it keeps the evidence and stops the monthly cycle
-- and the readiness report from treating it as a live tenant.
ALTER TABLE "Site" ADD COLUMN "retiredAt" TIMESTAMP(3);
