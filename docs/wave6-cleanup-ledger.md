# Wave 6: cleanup ledger status

Executable companion: `tests/wave6-cleanup-ledger.test.ts` fails if a deleted item
returns or a still-gated item is deleted without its cutover.

Rule (from `docs/seo-funnel-spine-plan.md` §8): every deletion needs either a
migrated consumer or a frozen read-only cutover. This file records which is which.

## Cutover performed

The crawl now feeds the funnel directly, so the legacy action producers are
retired rather than merely idle:

| Producer | Was called from | Now |
|---|---|---|
| `syncCrawlIssuesToActions` | `scripts/job-worker.ts` after every crawl | `refreshFunnelForSite` — crawl evidence → O7/O8 opportunities |
| `syncSeoOpportunitiesToActions` | `POST /api/sites/:id/actions/sync-seo` | same funnel refresh (the endpoint keeps its route) |

The legacy tables (`ResearchAction`, `ResearchRun`, `SeoResearchRun`,
`ArticleKeywordResearchRun`, …) are **not** deleted and **not** migrated. They
stay readable for audits and spend reconciliation, which is why the legacy read
routes still work.

## Deleted

| Item | Why it was safe |
|---|---|
| `lib/research/crawl-actions.ts` | its only production callers were the crawl job and the sync endpoint, both cut over; its type moved to `crawl-live-check.ts` with its consumer |
| `lib/research/seo-actions.ts` | derived actions from other actions — the pattern the funnel replaces; last caller was the sync endpoint |
| `scripts/sync-seo-actions.ts` | manual script for the retired producer |
| `tests/crawl-actions.test.ts` | tested the deleted module |
| `tests/seo-actions-authority.test.ts` | tested the deleted module |
| `tests/crawl-gap-action-lifecycle.test.ts` | requirement **ported**, not dropped: `tests/funnel-crawl-gap-lifecycle.test.ts` asserts crawl gap → opportunity → task → delivery → outcome |
| rank-history precedence overlay | replaced by `buildRankHistory`, which keeps both series tagged instead of overwriting one with the other (DS-05) |

## Still gated on legacy route retirement

These have live read consumers, so deleting them would break a screen the owner
still uses. They stay until the legacy routes are archived.

| Item | Blocking consumer |
|---|---|
| `lib/pipeline/lineage.ts`, `lineage-types.ts` | `/actions/[actionId]` provenance panel |
| `RankSnapshot` table and its writers | `/api/sites/:id/rank-history` sampled series, `rank-history` page |
| `ResearchAction.evidence` JSON lineage | legacy work queue and findings views |
| `lib/crawler/technical-actions.ts`, `lib/research/keyword-actions.ts`, `lib/dataforseo/prelaunch-actions.ts` | legacy research/prelaunch read paths and their fixtures |
| `ResearchRun.actionCount/findingCount/sourceCount` | legacy research run views |

## What must happen before the gated items go

1. Archive the legacy routes (`/legacy-work`, `/legacy-opportunities`, `/actions/[id]`,
   `/findings`, `/results`) behind a read-only flag or remove them.
2. Confirm no scheduled job writes the legacy tables, then flip
   `CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict` so any accidental write fails loudly.
3. Delete the gated items, then drop the frozen tables in a separate, reversible
   migration — never in the same change as the code.
