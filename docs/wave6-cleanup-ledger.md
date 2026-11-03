# Wave 6: cleanup ledger status

Executable companion: `tests/wave6-cleanup-ledger.test.ts` fails if a deleted item
returns or a still-gated item is deleted without its cutover.
Writer audit: `npx tsx scripts/legacy-writer-audit.ts` reports which legacy tables
still have producers, and exits non-zero if a frozen table gains a writer.

Rule (from `docs/seo-funnel-spine-plan.md` §8): every deletion needs either a
migrated consumer or a frozen read-only cutover.

## Step 1 — legacy routes archived: done

The pre-funnel screens redirect to the funnel surface that replaced them. They
stay on disk, so the history is still reachable, and `CRAWLSEO_LEGACY_ROUTES=live`
serves them again without a code change.

| Archived route | Sends the reader to | Mechanism |
|---|---|---|
| `/sites/:id/legacy-work` | `/sites/:id/work` | flag-gated redirect |
| `/sites/:id/legacy-opportunities` | `/sites/:id/opportunities` | flag-gated redirect |
| `/sites/:id/findings` | `/sites/:id/opportunities` | flag-gated redirect |
| `/sites/:id/results` | `/sites/:id/work` | flag-gated redirect |
| `/sites/:id/actions/:id` | `/sites/:id/work` | removed (no flag) |

The sidebar no longer carries a Legacy group: archived screens are URL-only.

## Step 2 — strict freeze: **not possible yet, and the audit says why**

`npx tsx scripts/legacy-writer-audit.ts` shows every legacy table still has a
producer. The research pipeline is the live business-research producer:

| Table | Writers |
|---|---|
| `researchAction` | `lib/agent-tasks/service.ts`, `lib/editorial/action-policy.ts`, `lib/research/content.ts`, `lib/research/keyword-actions.ts`, `lib/research/runner.ts` |
| `researchRun` | `lib/research/runner.ts`, `lib/research/service.ts` |
| `researchFinding` | `lib/research/runner.ts` (nested) |
| `seoResearchRun`, `seoResearchTask` | `lib/dataforseo/research.ts`, `lib/dataforseo/prelaunch-runner.ts` |
| `articleKeywordResearchRun` | `lib/dataforseo/research.ts` |
| `rankSnapshot` | the rank-tracking sync |

Flipping `CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict` now would break business research
and keyword tracking. That migration is **DS-16** ("complete remote
business-research lifecycle"), not cleanup, so the freeze stays off and
`FROZEN_TABLES` in the audit is empty on purpose. The audit is the gate: when the
research runner writes evidence instead, the table becomes write-free, and the
freeze can cover it.

## Step 3 — deletions: done for everything that became unreferenced

| Item | Why it was safe |
|---|---|
| `lib/research/crawl-actions.ts` | crawl job and sync endpoint cut over to the funnel; its type moved to `crawl-live-check.ts` with its consumer |
| `lib/research/seo-actions.ts` | derived actions from actions — the pattern the funnel replaces |
| `scripts/sync-seo-actions.ts` | manual script for the retired producer |
| `lib/pipeline/lineage.ts`, `lineage-types.ts` | their only consumer was the legacy action detail, which step 1 removed |
| `tests/crawl-actions.test.ts`, `tests/seo-actions-authority.test.ts` | tested deleted modules |
| `tests/crawl-gap-action-lifecycle.test.ts` | requirement **ported**: `tests/funnel-crawl-gap-lifecycle.test.ts` asserts crawl gap → opportunity → task → delivery → outcome |
| `tests/pipeline-lineage.test.ts` | requirement **ported**: `tests/action-provenance-render.test.ts` now asserts the funnel page shows both legs, names producers, and states a missing hop |
| rank-history precedence overlay | replaced by `buildRankHistory`, which keeps both series tagged (DS-05) |

## Correction to the original ledger

`RankSnapshot` was listed for deletion as duplication. DS-05 proved the opposite:
a sampled SERP rank is a *different semantic* from a Search Console average
position, and `RankSnapshot` is the only store of the sampled series. It is
therefore retained, and the two series are now returned tagged instead of one
overwriting the other.

## Still gated, with the exact blocker

| Item | Blocking consumer | Unblocks when |
|---|---|---|
| `lib/crawler/technical-actions.ts` | `/api/internal/sites/:id/technical-actions/reassess` | the technical reassess endpoint moves to the funnel detectors |
| `lib/research/keyword-actions.ts` | `POST /api/sites/:id/keyword-research/actions` (a UI button) | the keyword-research button refreshes the funnel instead |
| `lib/dataforseo/prelaunch-actions.ts` | `POST /api/projects/:projectId/prelaunch-research/:runId/actions` | DS-16 gives domainless projects a funnel evidence path |
| `ResearchAction.evidence` JSON lineage | legacy work/findings views | those views are archived |
| `ResearchRun.actionCount/findingCount/sourceCount` | legacy research run views | same |

## Order that remains

1. Migrate the research runner to write `research_finding` evidence (DS-16), so
   `researchRun`/`researchFinding`/`researchAction` stop growing.
2. Point the three remaining endpoints at the funnel, then delete the factories.
3. Re-run `scripts/legacy-writer-audit.ts`; when it reports write-free, add the
   table to `FROZEN_TABLES` and flip `CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict`.
4. Drop the frozen tables in a separate, reversible migration — never with code.
