-- The article lane polls the editorial service through the durable job queue.
-- Additive: existing job kinds are untouched.
ALTER TYPE "JobKind" ADD VALUE IF NOT EXISTS 'EDITORIAL_ARTICLE';
