-- A page delivery waits for the human to create the Wix page; the worker
-- probes the route and resumes on its own.
ALTER TYPE "AgentTaskStatus" ADD VALUE 'AWAITING_TARGET';

-- A route probe is its own job so a parked delivery is resumed without a
-- human clicking anything.
ALTER TYPE "JobKind" ADD VALUE 'WIX_DELIVERY';
