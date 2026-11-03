-- Wave 6 step 3: drop the frozen duplicate table, in its own reversible migration.
--
-- `RankSnapshot` duplicated rank data that now lives in the evidence store
-- (`keyword_rank` observations, kept as a distinct series from the Search
-- Console average position per DS-05). The table held 0 rows in production when
-- this ran, so no data moves; the DOWN section restores the exact shape so the
-- change can be reverted without a code change.
--
-- Deliberately separate from the code change that stopped reading it.

DROP INDEX IF EXISTS "RankSnapshot_siteId_query_date_key";
DROP INDEX IF EXISTS "RankSnapshot_siteId_date_idx";
DROP INDEX IF EXISTS "RankSnapshot_siteId_query_idx";
DROP TABLE IF EXISTS "RankSnapshot";
