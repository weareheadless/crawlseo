# Pilot monthly bundle — Atelier de l'harmonie

**Status: Phase 0 contract — 2026-11-05.** This is the one-page agreement for the
first real monthly evidence bundle. It authorises collection only. It does not
authorise opportunity generation, article drafting, board changes or publication.

## Site and month

| Field | Value |
|---|---|
| Site | Atelier de l'harmonie |
| Domain | `atelier-harmonie.com` |
| Site ID | `cmulsoosk000uoyqfntc58hx5` |
| Project ID | `cmulsoose000soyqfuk5fji4m` |
| Month | `2026-11` (current calendar month, UTC) |
| Locale | `fr:2250` (French / France) |
| Idempotency key | `monthly:cmulsoosk000uoyqfntc58hx5:2026-11:bundle` |

Susi is the second pilot and is not part of this contract.

## What the bundle contains

| Section | Source | Cap | Paid? |
|---|---|---|---|
| Business knowledge | Accepted/latest `BusinessKnowledgeDocument` revision projected to `knowledge_fact` | current revision | no |
| Crawl evidence | Latest completed crawl, projected by `backfillSiteEvidence` | current crawl | no |
| GSC queries/pages | Current Search Console performance window, projected by `backfillSiteEvidence` | current window | no |
| Keyword metrics | DataForSEO Labs `keyword_overview/live` | 30 queries (target 20–40) | yes |
| SERP snapshots | DataForSEO `serp/google/organic/live/advanced` | 10 queries | yes |
| AEO/GEO | DataForSEO Google AI Overview item on an advanced SERP | 12 questions/queries (target 10–20) | yes |
| News/events | Google News RSS (existing research provider) | 20 items | no |
| Costs/receipts | `ResearchBudgetReservation`, `RawProviderResponse`, `ResearchRun` | recorded | — |

### How the queries and questions are selected

- **Keyword metrics:** current-window `keyword_rank` evidence, aggregated by
  query and ordered by first-party impressions. The top 30 are bought once.
- **SERP snapshots:** the top 10 of the same ranked list.
- **AEO/GEO:** the stored `question_coverage` set is used only when the question is
  written in the site's language. The Atelier question set is English template
  text, so the bundle uses the next-ranked French Search Console queries instead.
  This measures the French market rather than an English proxy. Questions that
  Google answers without an AI Overview are recorded as `overview_absent`, not as
  a zero-visibility observation.
- **News/events:** Google News RSS queries built from the business knowledge:
  the business name; the first two services with the business location; the same
  two services with the service area; and the service area plus `artisanat
  d'art`. Six free queries, deduplicated, capped at 20 items.

### Reuse rule

The bundle reuses only evidence that carries this bundle's scope: the same
`locale`, and `product: "keyword_overview"` for keyword metrics, `device:
"desktop"` for SERPs, or `surface: "google_ai_overview"` for AEO. Older ad-hoc
rows do not carry those dimensions, so they stay in the store for audit but are
not treated as this month's bundle. A second bundle run for the same site/month
returns the stored receipt without buying anything.

## Storage

No new table, pipeline, recommendation schema or scoring layer.

| Table | Use |
|---|---|
| `ResearchRun` | Bundle manifest: month, approval reference, status, cost, idempotency key, report |
| `ResearchSource` | News/event items for this bundle, under the bundle run |
| `RawProviderResponse` | Immutable DataForSEO payload, task id, cost and status |
| `EvidenceRecord` | Normalized keyword, SERP, crawl, GSC, knowledge and AI visibility facts |
| `ResearchBudgetReservation` | Per-call reservation and settlement against the project allowance |

## Cost

| Field | Value |
|---|---|
| Bundle ceiling | **$0.10** (`10,000,000` micros) |
| Estimated cost | **~$0.095** (2 keyword batches ~$0.045, 10 SERPs ~$0.020, 12 AI Overviews ~$0.030) |
| Actual bundle cost | **$0.091480** (run `cmw34vs610001oypyuogx5yjs`) |
| Project monthly allowance | **$1.00** |
| Committed before the bundle | **$0.673636** |
| Committed after the bundle | **$0.765116** |
| Remaining after the bundle | **$0.234884** |

The cap is checked before every paid call. A call that would cross the bundle
ceiling or the project's remaining allowance is refused; the run is recorded as
partial rather than retried at full cost. Provider receipts are the source of
truth for the actual amount. The first execute hit a missing
`CREDENTIAL_ENCRYPTION_KEY` in the `tsx` process; the free sections and the news
sweep were stored, and the paid sections were completed by an explicit
`--resume`. The run report keeps the previous attempt under `previousAttempt`,
and the budget ledger carries a reconciliation row for the resumed AEO calls so
the remaining allowance is not overstated.

## Stored result

Run `cmw34vs610001oypyuogx5yjs`, status `COMPLETED`, month `2026-11`.

| Section | Stored | Reused | Cost |
|---|---:|---:|---:|
| Business knowledge | 9 facts | 0 | $0 |
| Crawl | 294 observations | 0 | $0 |
| GSC | 215 observations | 0 | $0 |
| Keyword metrics | 18 (30 requested; 12 returned no provider metrics) | 0 | $0.027480 |
| SERP snapshots | 10 | 0 | $0.020000 |
| AEO/GEO | 12 Google AI Overview observations | 0 | $0.044000 |
| News/events | 20 sources | 0 | $0 |
| **Total** | | | **$0.091480** |

Evidence totals for the site after the bundle: 1,027 crawl observations, 447
keyword-rank rows, 229 GSC page rows, 56 keyword-metric rows, 38 SERP snapshots,
16 AI visibility observations, 17 knowledge facts, 14 question-coverage rows, 2
backlink profiles. The bundle added 18 keyword metrics, 10 SERP snapshots and 12
AI Overview observations, plus 20 news sources. It created no research action,
finding, opportunity or agent task.

## Approval

Execute requires an explicit reference:

```
--approval <owner-reference>
```

The reference is written into `ResearchRun.brief.approvalReference` and
`ResearchRun.report.bundle.approvalReference`. It is not inferred from the
command name or the month.

Approval reference for this pilot: **`goal-phase1-atelier-2026-11`** — the Phase 1
goal instruction in this session. The CLI records the exact string; it is not
inferred from the command name or the month.

## Commands

Dry run (zero paid calls, zero writes):

```bash
npx tsx scripts/research-bundle.ts \
  --site cmulsoosk000uoyqfntc58hx5 \
  --month 2026-11 \
  --dry-run
```

Execute after approval:

```bash
npx tsx scripts/research-bundle.ts \
  --site cmulsoosk000uoyqfntc58hx5 \
  --month 2026-11 \
  --execute \
  --approval <owner-reference>
```

Useful options: `--cap-usd 0.10`, `--keyword-queries 30`, `--serp-queries 10`,
`--aeo-questions 12`, `--news-items 20`, `--language fr`, `--country FR`,
`--json`.

Exit codes: `0` planned/completed/existing bundle, `1` unexpected failure or an
empty bundle, `2` usage/approval error, `3` cap refusal, `4` missing DataForSEO
credentials or an interrupted run, `5` partial bundle (recorded).

## Acceptance checks

1. Dry run completes with zero paid calls and prints the selected
   keywords/questions, expected calls, estimate, cap, storage plan and whether a
   bundle already exists.
2. One approved execute run stores the bundle for Atelier.
3. Raw payloads and normalized evidence are queryable by site/month.
4. A second execute run returns the existing receipt and makes zero paid calls.
5. Actual cost is recorded on `ResearchRun` and in the budget reservations.
6. No opportunity, board, scoring or task behaviour changes.
7. Tests cover idempotency, cap refusal, dry run, storage shape, missing
   credentials and partial provider failure.
8. The handoff reports commands, exit codes, evidence counts by kind, spend and
   artifacts.

## Explicitly out of scope

- Opportunity or article-idea generation.
- Any LLM proposal call.
- Board, lane, scoring or recommendation changes.
- Packet builder, decision schema, per-candidate ledger, shadow pipeline or
  rollback machinery.
- Legacy detector changes.
- A new pipeline or table.
- Weekly DataForSEO spend.
- Publication, task creation or automatic acceptance.
- Reusing the prior ad-hoc DataForSEO rows as if they were this bundle.
