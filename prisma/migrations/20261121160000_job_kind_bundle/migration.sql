-- The monthly DataForSEO bundle is a scheduled stage now, so it needs a job kind
-- of its own: it is the one stage that must survive a worker restart.
ALTER TYPE "JobKind" ADD VALUE IF NOT EXISTS 'BUNDLE';
