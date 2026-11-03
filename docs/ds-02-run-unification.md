# DS-02: unifying the research run families

Status: **specified, not implemented.** Wave 6 leaves this as the one open item
that blocks freezing (and later dropping) `articleKeywordResearchRun`,
`seoResearchRun` and `seoResearchTask`.

## Why it is not a cleanup step

The plan keeps `ResearchRun` as the spine's run model (§4) and has DS-02 replace
the three DataForSEO/prelaunch run families with it. That is an architecture
change with its own acceptance criteria, not a deletion: the run row is not just a
payload, it is the **job record** — status, idempotency, monthly caps, parent/child
linkage and cost.

The feature is live: 26 article keyword runs exist and the most recent one was
requested the day before this spec. Refactoring it inside a cleanup pass would put
a paid feature at risk for checklist progress, so the remaining work is written
down here instead of half-done.

## Progress

| Step | State |
|---|---|
| 1. Schema only | **done** — `ResearchRun` gained `idempotencyKey`, `parentRunId`, `seed`, `providerTaskId`, `providerLanguageCode`, `providerLocationCode`, `attemptedAt`, the two unique constraints, and `ARTICLE_KEYWORD`/`PRELAUNCH` kinds. Migration `20261103150000_ds02_run_unification_schema` with a `down.sql`. |
| 2. Dual-write | **done for the article family** — `syncArticleRunToResearchRun` writes the final state at job completion; the 26 existing runs were backfilled, so the shadow has full parity. |
| 3. Read switch | next — needs creation-time shadows as well, or in-flight runs disappear from the screen. |
| 4. Write switch | after 3 |
| 5. Freeze | after 4 |
| 6. Drop | after 5 |

## What already moved (so the cutover is smaller)

| Piece | State |
|---|---|
| Provider results | bridged into `keyword_metrics` / `analytics` / `backlink_profile` evidence with the raw payload in `RawProviderResponse` |
| Run `result` payload | released for bridged runs (8 of 24), so it is not a second copy |
| Keyword research screen | reads rows from evidence, falls back to `result` only for unbridged runs |

What remains is the bookkeeping: status, idempotency, caps and linkage.

## Target model

Add to `ResearchRun`:

| Column | Why |
|---|---|
| `idempotencyKey String?` + `@@unique([projectId, kind, idempotencyKey])` | replaces the per-family dedupe |
| `parentRunId String?` + `@@unique([parentRunId])` | replaces the article parent/serp self-relation |
| `seed String?` | the seed query/idea the run was requested for |
| `providerTaskId String?` | joins to `RawProviderResponse` |
| `providerLanguageCode String?`, `providerLocationCode Int?` | locale resolution for the provider call |
| `attemptedAt DateTime?` | retry bookkeeping the job currently keeps on the run |

`ResearchRunKind` gains `ARTICLE_KEYWORD` and `PRELAUNCH` so the existing values
stay meaningful.

## Order of operations

Each step ships on its own and is reversible.

1. **Schema only.** Add the columns and kinds; nothing reads them yet.
2. **Dual-write.** `requestArticleKeywordResearch` writes the `ResearchRun` row
   beside the legacy row, same identity. Zero behavioural change; gives the
   cutover a populated target with no backfill.
3. **Read switch.** The screen and the bridge read `ResearchRun`; the legacy row is
   still written. Verify the screen against the 26 existing runs.
4. **Write switch.** Stop writing the legacy row; keep the job payload pointing at
   `ResearchRun`. This is the step that makes the table write-free.
5. **Freeze.** Add `articleKeywordResearchRun` to `FROZEN_CREATES`, run
   `scripts/legacy-write-watch.ts` over a window, then to `FROZEN_NOW`.
6. **Drop.** A separate migration with `down.sql`, as `RankSnapshot` was.
7. Repeat 1–6 for `seoResearchRun`/`seoResearchTask`, which carry the extra
   prelaunch (project-scoped, no site) case.

## Acceptance

- Steps 2–3 produce identical screen output for the existing runs.
- After step 4, `scripts/legacy-writer-audit.ts` reports no scheduled writer for
  `articleKeywordResearchRun`.
- `scripts/legacy-write-watch.ts --hours 6` is clean after step 5.
- The drop's `down.sql` restores the table, indexes and foreign keys.
- No paid run is lost or duplicated: run counts and `RawProviderResponse` counts
  match before and after.

## Guard

`tests/wave6-run-family-guard.test.ts` fails if the legacy run tables disappear
before this spec's steps are done, so nobody drops them by accident.
