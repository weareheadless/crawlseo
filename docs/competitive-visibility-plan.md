# Competitor visibility and opportunity quality: implementation plan

**Status: implementation plan. 2026-11-23.**
Parent requirements: [product operating model](crawlseo-product-operating-model.md).
Read with the root `AGENTS.md` ("AI owns context; code owns facts", "No silent
truncation", "Universality is non-negotiable") before writing code.

## Goal

The board should let an SEO answer three questions about any cluster:

1. **Who holds the positions we want?** — named domains, measured, per query.
2. **Why do they hold them, and what is missing on our page?** — a specific,
   checkable deficit against a specific competitor URL.
3. **What did we win after the work shipped?** — before/after position against
   the competitor that held it.

Today it answers none of them, because the evidence underneath is either empty,
mis-collected, or not attached to the thing that displays it. That is the whole
problem: the detectors are mostly reasonable and the board is mostly reasonable,
but the numbers feeding them are not real.

## Definition of winning (the end state this plan is measured against)

Per cluster, per week, from measured SERP data:

- **Coverage** — share of the cluster's tracked queries where we rank in the top 10.
- **Share of voice** — CTR-weighted visibility across the tracked queries, ours
  and each named competitor's, computed from the same snapshots.
- **A cluster is won** when our share of voice exceeds every named competitor's
  for four consecutive monthly samples, and at least one delivered opportunity in
  that cluster has been measured as won.

Those three numbers are the product. Everything below exists to make them true.

## Current state, measured

Read from the production database on 2026-11-23. These are the reasons the
questions above cannot be answered, in order of damage.

| Fact | Value | Consequence |
|---|---|---|
| Stored organic SERP URLs that are `google.com/goto?url=…` redirect wrappers | **247 of 340** | "who ranks" is unanswerable; our position never matches |
| `serp_snapshot` rows whose `topUrl` is a wrapper | **72 of 85** | every snapshot's top result is a search engine |
| `competitor_rank` evidence rows | **0** | no competitor is ever measured |
| `share_of_voice` evidence rows | **0** | no visibility number exists |
| `SiteProfile.competitors` | **null on 8 of 8 sites** | nothing names a competitor |
| `provider:referringDomainGap` writes | **0** (2 `backlink_profile` rows total) | O9 backlink gap can never fire |
| `DemandMapCluster.tracked` true | **0 of 540 clusters** | the tracked grid is empty everywhere |
| `keyword_rank` rows / producers | 39,700 / `search_console` only | ranks are monthly GSC averages, never sampled SERPs |
| Clustered queries with a measured volume (Susi) | **53 of 1,226** | impact collapses to `hypothesis`, score capped at 15 |
| Opportunities attached to a cluster (Susi) | **46 of 691** | the cluster page says "no opportunity here" |
| `evidenceRecord` of kind `internal_link_graph` / `vitals` | 0 / 0 | two detectors have no input at all |
| `OutcomeObservation` rows / `Task` rows | **0 / 17** | delivered work is never measured |

Two consequences worth stating plainly, because they are the reason the board
looks empty of good work:

- **O3 fires on a false premise.** `collectSerpSnapshots` computes
  `ourPosition = items.findIndex(url.includes(domain)) + 1` and
  `covered = ourPosition === 0 || ourPosition > 10`. With wrapper URLs,
  `ourPosition` is always 0, so `covered` is always true and every snapshot claims
  "competitors answer this, we do not". Susi's 15 live O3 opportunities and
  casamigo's 10 come from that claim.
- **O2 (striking distance) is the strongest detector we have and it is dormant.**
  On Susi, 119 O2 rows are parked, 110 with `score_below_threshold` and a median
  score of 1.0, because the query has impressions but no volume, so impact is
  `hypothesis` and the score is capped at 15 — under the 3-point park threshold
  once freshness and completeness multiply in.

## Design

Five layers, each shippable and reversible. Nothing here adds a second data
owner: every number is an `EvidenceRecord`, every projection is recomputed.

```
 1  SERP truth        one snapshot = real organic results, real positions
        │
 2  Map attachment    every rank/metric row resolves to its cluster (a fact:
        │             the membership row exists)
 3  Competitor evidence  competitor_rank per query/domain, from the same snapshot
        │
 4  Tracked grid      declare the queries we track; chart free daily history,
        │
 5  Winning            page-level gap brief, backlink gap, SoV scoreboard,
                       before/after proof
```

Layers 1–3 make the existing detectors honest. Layers 4–5 are what turn an
honest board into a plan that outranks someone.

### What the model decides, and what code decides

- **The model decides** which domains are competitors (from DataForSEO Labs
  `serp_competitors` plus business knowledge), what a cluster's topic is, and
  which deficit matters. A human accepts the competitor set once, per site, into
  `SiteProfile.competitors`.
- **Code decides** that a SERP item at `rank_absolute` 3 is position 3, that a
  query with a membership row is in that cluster, and how many tracked queries we
  cover. No competitor list, domain, city, path or language ever appears in `lib/`.

### The competitor set is data, not code

`providers` defaults to `["reddit","news","web","competitor"]` for every site.
A policy may disable a provider; the platform default is uniform. Enabling the
competitor provider for one tenant and not another is a rollout mistake, not a
configuration choice.

## Issues

| Work ID | Result an SEO can see | Depends on |
|---|---|---|
| [CMP-001](https://github.com/weareheadless/crawlseo/issues/166) | A snapshot lists real ranking domains; our position is a real number or honestly absent | — |
| [CMP-002](https://github.com/weareheadless/crawlseo/issues/167) | Every opportunity on the board belongs to the topic it serves | — |
| [CMP-003](https://github.com/weareheadless/crawlseo/issues/168) | A competitor leaderboard per cluster: who ranks, where, for how many of our queries | CMP-001, CMP-002 |
| [CMP-004](https://github.com/weareheadless/crawlseo/issues/169) | Weekly rank-over-time per tracked query from free history, with the grid no longer empty | CMP-001, CMP-002 |
| [CMP-005](https://github.com/weareheadless/crawlseo/issues/170) | Every tracked query has a measured volume, so the board shows click upside instead of parked rows | CMP-004 |
| [CMP-006](https://github.com/weareheadless/crawlseo/issues/171) | Each opportunity names the pages above us and the specific deficit on ours | CMP-002 |
| [CMP-007](https://github.com/weareheadless/crawlseo/issues/172) | A link play with actual targets: domains linking to the pages above us, not to us | CMP-003 |
| [CMP-008](https://github.com/weareheadless/crawlseo/issues/173) | A cluster scoreboard: our share of voice vs each competitor, and the queries we lose | CMP-003, CMP-004 |
| [CMP-009](https://github.com/weareheadless/crawlseo/issues/174) | Proof per delivered task: did the position move, did we pass the competitor | CMP-004, CMP-008 |

## Spend

All figures are DataForSEO list estimates from `BUNDLE_COST_ESTIMATES`
(`serpPerQueryMicros: 2_000`, `keywordPerQueryMicros: 1_500`). Every issue must
reserve against the project allowance and return a receipt; a run that hits its
cap reports the cap, it does not silently stop. Per site, per month:

| Item | Volume | Cost |
|---|---|---|
| First-party weekly position history (Search Console rows we already store) | every tracked query, daily rows bucketed to weeks | **$0** |
| Monthly competitor sample on the watch list | 24–28 queries (live opportunities + one head per cluster) | ~$0.06 |
| Monthly volume for the tracked grid | ~1,200 queries, re-bought only when the grid changes | ~$1.80 |
| Backlink gap (one bulk call per competitor set) | ~5 domains | < $0.50 |
| Competitor page fetches (cached 30 days, top 3 per opportunity) | ~60 URLs | $0 |
| Outcome proof, at delivery + 28 days | only the queries being proved | $0 |

Fleet total: about **$5/month** for all active sites, most of it the one-off grid
volume; the SERP sampling itself is cents.

### Why not a weekly SERP sample

Measured on daily Search Console rows with ≥10 impressions at both ends:

| Gap | Real movement (median) | Noise floor of one day's estimate |
|---|---|---|
| 1 day | 0.40 | 2.14 |
| 7 days | 0.80 | 1.14 |
| 14 days | 1.10 | 0.80 |
| 28 days | 1.35 | 0.57 |

A day averages ~14 impressions per query, so one day's position is itself ±2
places. A weekly SERP would report a move smaller than the uncertainty of the data
judging it. Bucketing the free daily rows into weeks does clear the noise: median
weekly bucket-over-bucket movement is **3.00** on one site (957 queries with ≥4
weeks) and **2.31** on another. The bundle also caps SERPs at 10 per site per
month (`DEFAULT_BUNDLE_CAPS.serpQueries`), so a 300-query weekly grid is not
reachable without a second collector buying the same fact.

No new paid product is introduced. The trend comes from evidence we already hold;
SERP spend only answers "who is there", monthly, on the queries we act on.

## Invariants (review checklist for every issue)

1. **No per-tenant shape.** No tenant id, domain, city, path or language in
   `lib/`. Cadence and tiers are declared policy, read identically everywhere.
2. **A judgement is never a code path.** Which domains are competitors, what a
   cluster means, which deficit matters — model or human, stored, never inferred
   from tokens. A *fact* (a membership row exists; a SERP item has a rank) may be
   computed.
3. **No silent truncation.** Every cap is a named constant and its dropped count
   is reported in the run result (`truncations`, `coverage`, `skipped`).
4. **Unobserved is not zero.** A cluster with no SERP data reports `unobserved`.
   It must never render as 0 % share of voice, and a detector must report
   `disabled` rather than empty.
5. **One reader, many callers.** A query→cluster resolution, a competitor set
   read, a share-of-voice computation: one exported function each.
6. **Prove on a disposable tenant, never on a customer.** Behaviour-changing
   issues run there first, then the fleet mechanism.
7. **Provenance holds.** Provider-sourced metrics keep their raw response and
   cost; no provider number is presented as first-party.

## Verification of the plan as a whole

The plan is done when, for one cluster on one site, all of the following are
readable in the app and traceable to a snapshot:

- the tracked queries in the cluster and our position for each, with the date of
  the sample;
- the competitors ranked above us, on which query, at which position;
- the specific page-level deficit against the top competitor URL;
- a delivered task with a before/after position for the same query;
- a share-of-voice series for the cluster with our line and theirs.

If any of those renders a number that cannot be traced to a stored observation,
the plan is not done — it is guessing, which is what it was written to stop.
