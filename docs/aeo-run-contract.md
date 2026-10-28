# AEO evaluation run contract (UI-053)

`runEvaluation` performs weekly and action-triggered evaluations using the UI-049 question set and UI-051/052 provider adapters. `AeoEvaluationRun` is the durable receipt and idempotency record, uniquely keyed by `(projectId, runId)`. Scheduled IDs are `weekly:<siteId>:<ISO-week-in-project-timezone>`; action IDs are `action:<actionId>`. A prior receipt is returned without new calls, including failed or incomplete runs.

The cap is a count of paid request attempts, not a monetary amount: default 30, maximum 60 per run; action re-asks are capped at one request per provider. The cap is checked before every adapter call. Failed, rate-limited and over-budget responses increment run failure counts but are never observations. Successful answers and explicit answer-absence states are stored as observations. Receipts record actual estimated cost in micros when supplied by the provider.

V1 does not pre-gate by money. Provider-account limits are the monetary guard. Perplexity reports a cost estimate when available; DataForSEO provides its cost estimate for Google SERP requests. Neither value is used to decide whether a request may be made.

Run status is `completed`, `partial`, `failed`, or `running` (the latter indicates a process stopped before finalization). A re-ask requires a cookie-authenticated owner and a site-scoped ResearchAction. Its prompt is the action's primary query, falling back to its title.

## Migration verification

Verified on the fresh dedicated local PostgreSQL database `crawlseo_ui053_eval_migrate_20261028_v2`: `prisma migrate deploy` applied all 43 migrations, `prisma migrate status` reported up to date, `prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` reported no difference, and `prisma validate` passed.
