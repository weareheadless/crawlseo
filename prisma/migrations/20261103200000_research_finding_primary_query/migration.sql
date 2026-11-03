-- The synthesizer already produces `primary_query` for every finding; it was
-- dropped at persistence, so the join runner had only a sentence to collect on.
-- This stores the phrase research wants validated.
ALTER TABLE "ResearchFinding" ADD COLUMN "primaryQuery" TEXT;
