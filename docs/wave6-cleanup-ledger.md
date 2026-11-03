# Wave 6: cleanup ledger status

Executable companions:
- `npx tsx scripts/wave6-status.ts [--strict]` — the three steps as checks with
  evidence, so drift fails a check instead of leaving a stale document.
- `npx tsx scripts/legacy-writer-audit.ts` — what *could* write a legacy table
  (static, creates vs updates).
- `npx tsx scripts/legacy-write-watch.ts [--hours N]` — what *did* write, plus
  crawls run outside the job queue.
- `tests/funnel-freeze-wiring.test.ts` asserts the *wiring*: the shared `db`
  client is wrapped when the flag is set, and is not when it is absent or has any
  other value. That is the half that failed in production.
- `tests/wave6-cleanup-ledger.test.ts` fails if a deleted item returns or a
  still-gated item is deleted without its cutover.

Note on end-to-end proof of the block: it cannot be exercised from outside,
because no live path attempts a legacy create any more — which is the desired
state. The evidence is therefore threefold: the flag is present in both running
processes (`/proc/<pid>/environ`), the wiring test proves the client wraps when it
is present, and the guard tests prove a wrapped client refuses creates while
allowing updates.
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

## Step 2 — strict freeze: enabled for the tables that are provably write-free

`npx tsx scripts/legacy-writer-audit.ts` now separates **scheduled-job** writers
(reachable from `scripts/job-worker.ts`) from request-path writers, because step 2
asks specifically about scheduled jobs. Only `rankSnapshot` has no writer at all, so
it is the only table the strict freeze covers today, with
`CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict` live in production:

| Table | Writers | Frozen |
|---|---|---|
| `rankSnapshot` | none at all (read-only historical store) | **yes** |
| `prelaunchResearchRequest` | no scheduled writer, but the paid prelaunch request endpoint still writes it | no |
| everything below | scheduled producers | no |

The remaining tables still have scheduled producers, so freezing them would break
those producers:

| Table | Writers |
|---|---|
| `researchAction` | `lib/agent-tasks/service.ts`, `lib/editorial/action-policy.ts`, `lib/research/content.ts`, `lib/research/keyword-actions.ts`, `lib/research/runner.ts` |
| `researchRun` | `lib/research/runner.ts`, `lib/research/service.ts` |
| `researchFinding` | `lib/research/runner.ts` (nested) |
| `seoResearchRun`, `seoResearchTask` | `lib/dataforseo/research.ts`, `lib/dataforseo/prelaunch-runner.ts` |
| `articleKeywordResearchRun` | `lib/dataforseo/research.ts` |
| `rankSnapshot` | the rank-tracking sync |

`FROZEN_NOW` in `lib/funnel/legacy-freeze.ts` lists exactly what the strict freeze
covers, and `tests/funnel-legacy-freeze.test.ts` fails if a table with a producer
is added to it. The audit is the gate: as each migration lands, the table stops
appearing as a scheduled writer and can be added to `FROZEN_NOW`.

## Progress made toward the remaining freeze (this wave)

Both DataForSEO families now project their stored results into evidence, so the
run tables are no longer the only home of that data:

- `lib/dataforseo/seo-research-evidence.ts` maps each completed `SeoResearchTask`
  to the evidence kind that matches what it measured — `analytics` for a domain
  overview, `backlink_profile` for a backlinks overview, `keyword_metrics` for a
  keyword seed (every row, not just a summary) — with the raw payload stored
  first and a task lacking a recorded cost skipped and reported. The
  `SEO_RESEARCH` job bridges each completed run; production backfill landed 3
  more keyword observations (33 total).

`lib/dataforseo/research-evidence.ts`
projects stored keyword runs into `keyword_metrics` evidence (raw payload first,
then evidence pointing at it, with the run's locale as a dimension and every
metric carrying a declared unit). The `ARTICLE_KEYWORD_RESEARCH` job bridges each
completed run, and the 24 runs already stored in production were backfilled:
10 keyword rows now sit in the evidence store as provider data. A run with no
recorded cost is skipped and reported rather than given a provenance it lacks.


Business research now reaches the funnel: `lib/research/finding-evidence.ts`
bridges each `ResearchFinding` into `research_finding` evidence, so the O13/O14
detectors turn winnable gaps into opportunities. Because of that the runner no
longer writes legacy actions by default (`CRAWLSEO_LEGACY_ACTION_WRITES=on`
restores it), which is the first half of retiring `researchAction`.

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

## Step 2a — what the audit can now prove, precisely

The audit distinguishes **creates** (the table grows) from **updates** (lifecycle
transitions on rows that already exist), and it states that import reachability is
an upper bound rather than execution:

```
1 create + 14 update (table still grows)  researchAction
2 create + 11 update (table still grows)  researchRun
2 create +  0 update (table still grows)  researchFinding
1 create +  7 update (table still grows)  seoResearchRun
6 update only (nothing new is created)    seoResearchTask
2 create +  8 update (table still grows)  articleKeywordResearchRun
no scheduled writer                       prelaunchResearchRequest
```

**Measured fact, and it contradicts the earlier assumption:** `researchAction` is
still growing in production. In one six-hour window it gained 242 rows with
`owner: "crawl-actions"` and `source: "crawl_issue"`, all stamped within the same
second — one crawl's worth.

That owner string belonged to `lib/research/crawl-actions.ts`, which was deleted
in wave 6 and is absent from the current web and worker releases. It is also
absent from the source checkout. So the writer is a process running older code
that has not been identified yet, and the claim "no scheduled job creates legacy
actions" is **not proven** — it is currently false in effect.

Investigation: the crawls behind that burst ran with **no `CRAWL` job rows**
(five crawls finished, zero jobs), so they came from something outside the job
queue, and no pm2 app or node process is running from an old release directory.
The writer has not been identified.

Rather than chase it further, the freeze now catches it. `FROZEN_CREATES` blocks
**creates** on `researchAction` while still allowing lifecycle **updates**, so
in-flight work can close and nothing new can be added. Any forgotten writer now
fails loudly with its own stack in the log — the freeze is the diagnostic.

`prelaunchResearchRequest` is excluded from create-blocking because its paid
request endpoint is still a live feature.

## DS-02 progress — the keyword research read path moved to evidence

The screen no longer needs the run's duplicated `result` blob:

- `lib/dataforseo/keyword-evidence-view.ts` resolves a stored run's raw response
  and returns its `keyword_metrics` evidence as table rows (highest volume first).
- A run that was never bridged (no recorded cost, or predating the bridge) falls
  back to its stored result, and a read failure degrades to that fallback rather
  than blanking the page — so nothing disappears from the UI.
- Measured on production: 24 completed runs, the 8 that hold keyword rows all now
  serve them from evidence (10 rows). The other 16 stored SERP results, not
  keyword lists, and render as before.

That is the read half of DS-02 for this family. The run row is now a job record
only, so `result` can be dropped from it once the write side moves too — which is
the remaining half, along with the same change for `seoResearchRun`/`Task`.

## Step 3c — two more factories retired

Both remaining action factories behind a live UI caller were cut over, so the
capability survives without the legacy write:

| Factory | Old behaviour | Now |
|---|---|---|
| `lib/research/keyword-actions.ts` | minted an Action from a keyword the owner picked | records the keyword as tracked demand (`keyword_universe_membership` evidence) and refreshes detection; the button reads "Track" |
| `lib/dataforseo/prelaunch-actions.ts` | minted Actions from a prelaunch run | the worker bridges prelaunch task results into evidence (project-scoped, no site) and the endpoint refreshes the funnel; the button reads "Detect opportunities" |

Neither endpoint lost its meaning: "this keyword matters" still enters the system,
it just enters as demand rather than as a hand-made task. One factory remains
gated: `lib/crawler/technical-actions.ts`, whose reassess endpoint carries
revision/approval semantics that need their own cutover.

## Step 2a — the freeze was never actually live (found and fixed)

`CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict` was in `/SEO/.env`, and every "verified"
check I ran read that value from a shell that had sourced it. The running
processes never had it:

- `stage-production-worker.mjs` never copied a `.env` into the worker release, so
  `start-worker-production.sh` sourced nothing and the worker — the process that
  writes the legacy tables — ran with the flag off.
- `start-production.sh`'s release branch never sourced the release `.env` either,
  so the web process hosting the technical-reassess endpoint ran with it off too.

Fixed in both places: the worker release now carries `.env` (mode 0600) and both
start scripts source it. Verified from `/proc/<pid>/environ`, not from a shell:

```
web (pid 3230538): strict; worker (pid 3229682): strict
```

`scripts/wave6-status.ts` now reads the flag from the live pm2 processes, so this
class of mistake fails a check instead of passing silently.

## Step 2 evidence — the standing check

`npx tsx scripts/legacy-write-watch.ts [--hours N]` reports what actually
happened, as opposed to what could happen:

- legacy rows created in the window, with their owners;
- crawls that finished with no CRAWL job touched within two minutes, i.e. run
  outside the queue.

It exits non-zero when either signal fires, so it can be scheduled.

**Measured after the create-block went live:** a three-hour window is
`clean: true` — zero legacy rows created, zero crawls. The earlier 242-row burst
sits outside it, and its five crawls were all normal backlogged jobs (created
2026-11-02 08:30, claimed 02:42–02:55), not out-of-band runs. My first
out-of-band metric was wrong: it compared finishes against jobs *created* in the
window, which flags every backlogged crawl. It now matches completion against
job activity.

So the position is: the block is live, nothing has been created since, and any
writer that reappears fails loudly with its stack in the worker log.

The tables that still grow from scheduled jobs are the research run families:
`researchRun` + `researchFinding` (kept by the spine as its run/finding models),
and `seoResearchRun` + `articleKeywordResearchRun` (the families DS-02 unifies).
Those creates are what blocks the freeze, not the updates.

## Step 3b — the frozen table was dropped, in its own reversible migration

`RankSnapshot` was the only table proven write-free, and it held **0 rows** in
production. Its reader (the rank-history sampled series) now reads `keyword_rank`
evidence instead, which is where sampled ranks belong per DS-05, so the table was
dropped in migration `20261103120000_drop_rank_snapshot`.

The drop is deliberately separate from the code change and reversible:
`prisma/migrations/20261103120000_drop_rank_snapshot/down.sql` restores the exact
table, indexes and foreign key.

With it gone, `FROZEN_NOW` is empty — the honest state, since no legacy table is
both write-free and still present. The mechanism stays armed: the next table
joins the set when its migration lands, and the guard test fails if one with a
producer is added.

## Correction to the original ledger

`RankSnapshot` was listed for deletion as duplication. DS-05 proved the opposite:
a sampled SERP rank is a *different semantic* from a Search Console average
position, and `RankSnapshot` is the only store of the sampled series. It is
therefore retained, and the two series are now returned tagged instead of one
overwriting the other.

## Still gated, with the exact blocker

| Item | Blocking consumer | Unblocks when |
|---|---|---|
| ~~`lib/crawler/technical-actions.ts`~~ | **deleted** — the endpoint answers `410 Gone`; a crawl plus the O7/O8 detectors replaces reassessment, and no caller existed anywhere | done |
| ~~`lib/research/keyword-actions.ts`~~ | **deleted** — the endpoint now records the keyword as tracked demand and refreshes detection | done |
| ~~`lib/dataforseo/prelaunch-actions.ts`~~ | **deleted** — the worker bridges prelaunch task results into evidence and the endpoint refreshes the funnel | done |
| `ResearchAction.evidence` JSON lineage | legacy work/findings views | those views are archived |

`tests/technical-actions.test.ts` was deleted with its factory; the endpoint's own
test now asserts the 410 and that it still authenticates.
| `ResearchRun.actionCount/findingCount/sourceCount` | legacy research run views | same |

## Order that remains

1. Migrate the research runner to write `research_finding` evidence (DS-16), so
   `researchRun`/`researchFinding`/`researchAction` stop growing.
2. Point the three remaining endpoints at the funnel, then delete the factories.
3. Re-run `scripts/legacy-writer-audit.ts`; when it reports write-free, add the
   table to `FROZEN_TABLES` and flip `CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict`.
4. Drop the frozen tables in a separate, reversible migration — never with code.
