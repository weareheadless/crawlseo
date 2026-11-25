# Architecture: the opportunity board — one scorer, evidence classes, and the state it reads

**Status:** authoritative for the opportunity board.
**Written:** 2026-11-25. Replaces the divergent descriptions in
`seo-funnel-spine-plan.md`, `demand-map-cluster-discovery.md` and the
"code-referenced architecture notes" section of `docs/README.md`, which are now
historical.

This document exists because the project has spent a year accumulating four
scoring paths, three clustering paths and two opportunity-detection paths, and
the board an SEO reads was ordered by the *oldest* of them. It states what the
system is, what the contracts are, what is legacy, and what changes. Read it
before touching `lib/funnel/scoring.ts`, `lib/research/priority.ts`,
`lib/research/opportunity-generation.ts` or any board query.

## 1. The one-paragraph version

A monthly pipeline buys evidence for a site (search demand, SERPs, competitor
positions, AI-visibility samples), the model turns that evidence into named work
with a page, a query set and an action, and a scorer orders that work so a person
reads the best opportunity first. **Code owns facts and arithmetic. The model
owns meaning.** The board is the product; everything else is transport to it.

## 2. What was measured before writing this

Not a summary of intentions — the state on 2026-11-25.

| Quantity | Value |
|---|---|
| tenants with a project | 8 |
| `Opportunity` rows | 1,965 |
| open (`detected`/`accepted`/`in_progress`) | 100 |
| `parked` | 1,734 |
| `delivered` | 10 |
| distinct scoring paths found | **4** |
| distinct clustering paths found | 2 (one retired in #226) |
| models in `prisma/schema.prisma` | 75 |
| migrations | 69 |
| tests | 257 files, 1,934 passing |

Per-tenant, the number that started this:

| tenant | country | open | clusters | clustered queries |
|---|---|---|---|---|
| susimacdonald | US | 22 | 24 | 24/24 |
| atelier-harmonie | FR | 20 | 13 | 13/13 |
| alaguillotine | US | 16 | 24 | 87/205 |
| casamigo | US | 15 | 14 | 21/279 |
| oceanicvibes | US | 13 | 13 | 13/13 |
| astridrincon | MX | 11 | 12 | 12/12 |
| inmersionfreediving | MX | 11 | 10 | 35/139 |
| superincompetence | US | 3 | 3 | 36/186 |

## 3. The contracts

Each is a real invariant with a test that fails when broken. If a change
contradicts one, the change is wrong or the contract needs an amendment — not a
quiet edit.

### 3.1 Evidence shape

`EVIDENCE_REGISTRY` (`lib/funnel/evidence-registry.ts`) declares, for every
`EvidenceRecordKind`, the producers, the required and optional dimensions, the
metrics and the window kind. `storeEvidenceRecord` validates against it and
rejects an undeclared key.

`tests/evidence-contract.test.ts` — every kind in the schema appears in the registry.
`tests/evidence-dimensions-declared.test.ts` — every dimension a writer stores is declared.

> **Why this is a contract and not a convenience.** Four times in two days an
> undeclared dimension made a writer reject its own write, which made the bundle
> `PARTIAL`, which the pipeline gate refused to build a map from. $0.73 of paid
> evidence was bought and discarded this way. The registry is right to reject; the
> check at the cheap end was missing.

### 3.2 No silent truncation

Every bound either processes the whole input (batching is transport) or reports
what it dropped in the run result (`truncations`, `skipped`, `deferredQueries`).
A cap that hides data is a bug. Selection by relevance is allowed and must be
commented as such.

### 3.3 Pipeline order and gating

`runResearchPipeline` (`lib/research/pipeline.ts`) runs `bundle → topic-map →
opportunities` in that order and refuses to advance on a stage that did not
complete. `PARTIAL` does not passed the gate unless `--allow-partial` is
explicit.

Two refresh flags, and they are not interchangeable:

| flag | cost | what it does |
|---|---|---|
| `refresh` | one model call | rebuild the map and the proposals from evidence already stored |
| `refreshBundle` | provider money | re-buy the month's evidence |
| `refreshJobMap` | model calls | re-judge the query tranche, so new queries stop being deferred forever |

> 183 of 186 queries were deferred on superincompetence because only `refresh`
> existed. The board showed one opportunity for a site with 186 queries of demand.

### 3.4 No deterministic fallback for a semantic field — with two standing exceptions

**This contract is currently broken in `lib/site/context.ts` and the document must
say so rather than assert the rule.**

`COUNTRY_WORDS` is a 12-entry regex table mapping words to country codes
(`/mexi|méxi|mexique/` → `MX`), and `LANGUAGE_COUNTRY` maps a language to a
market (`fr` → `FR`). Both are deterministic decisions about a semantic field —
exactly what §3.4 forbids — and both are live, because business knowledge does not
yet emit `market` reliably for every tenant.

They are tolerated as **documented debt, not as design**:

| table | why it exists | what must replace it |
|---|---|---|
| `COUNTRY_WORDS` | the extractor's `market` field is new; older revisions have only free-text `location` | the extraction prompt, already done in #228 — the table can retire once every tenant has re-extracted |
| `LANGUAGE_COUNTRY` | a site with no stated market at all | nothing, for `en` — that is why `en` is deliberately absent. For `fr`/`de`/`es` it is a reasonable signal about the language, kept until a stated market exists |

Both were verified this week to behave correctly on real tenants
(`countryFromText("United States") → US`, and `en` correctly resolves to nothing).
That does not make them contracts. **The rule is: no new table of this kind may be
added, and the two that exist are removed when their data source lands.** Anything
added tomorrow needs a model decision instead.

The one sanctioned exception remains the tenant-wired Wix delivery connector.

### 3.5 Universality

No tenant names, domains, cities, page paths or service words in `lib/`. The one
sanctioned exception is the tenant-wired Wix delivery connector, which speaks two
tenants' packet formats on purpose (see §3.4 for the two temporary country tables,
which are tenant-shaped data in code and are on their way out).

Verified this week on 8 tenants: `resolveSiteContext` returns a language for all 8,
a country for 6 from data, and 2 correctly report a blocker rather than a guess.



## 4. The architecture, as it stands

```
                    ┌──────────────────────────────────────┐
   site, profile ──▶ │ evidence bundle (monthly, paid)       │  DataForSEO + GSC + crawl
   business knowledge│  keyword_metrics, serp_snapshot,      │
                     │  competitor_rank, ai_visibility, news │
                     └───────────────┬──────────────────────┘
                                     ▼
                     ┌──────────────────────────────────────┐
                     │ topic map (one model pass per month)  │  clusters, needs, markets
                     │  job map = the judgement of queries   │  verdicts, deferred counted
                     └───────────────┬──────────────────────┘
                                     ▼
                     ┌──────────────────────────────────────┐
                     │ opportunities (model drafts work)     │  page, queries, action
                     │  + detectors (crawl, AEO, technical)  │  hygiene rows
                     └───────────────┬──────────────────────┘
                                     ▼
                     ┌──────────────────────────────────────┐
                     │ SCORING  ← the subject of §5          │  order the board
                     └───────────────┬──────────────────────┘
                                     ▼
                     ┌──────────────────────────────────────┐
                     │ board (person reads, accepts, works)  │
                     └──────────────────────────────────────┘
```

The evidence layer, the map and the drafting are in reasonable shape: this week
they produced credible boards on four tenants after being repaired. **The scoring
layer is where the architecture is broken**, and it is the only layer a person
touches.

## 5. The scoring problem

### 5.1 There are four scoring paths and only one of them is read by the product

| # | path | used by | orders the board? |
|---|---|---|---|
| 1 | `computeScore` — `lib/funnel/scoring.ts` | writes `Opportunity.scoreValue` | **yes** |
| 2 | `proposalPriority` + `comparePriority` — `lib/research/priority.ts` | the markdown report only | no |
| 3 | `opportunityPriority` — `lib/ai-seo/opportunity-priority.ts` | nothing (orphan) | no |
| 4 | `reconcileScore` — `lib/research/score-reconciliation.ts` | nothing (orphan) | no |

There is also a fifth, partial case that is not a scorer but behaves like one:
`orderByOpportunity` (`lib/research/opportunity-evidence.ts`) decides **which
queries carry competitor context into the drafting call** — by gap, then nearest
competitor, then demand. It orders queries rather than opportunities, so it is not
on the list above, but any change to "how do we rank" has to account for it or the
model gets a differently-sorted brief than the board describes.

Path 2 is, by inspection, **the design the board should have**. It already:

- starts expected clicks from `reach * ctr * intentFit` where `reach` is *observed
  impressions*, never provider volume ("provider volume is market size: it is
  shown next to the estimate, never multiplied into it, or a single 1.2M-search
  informational term outranks every page that earns money");
- holds content work when the site has fewer than `MIN_REACH_IMPRESSIONS = 100`
  impressions — the "foundations first" gate, which is exactly the new-site
  behaviour the SEO review asked for;
- bands work as `measured money → measured content → foundation → unmeasured
  money → unmeasured content`;
- reports a `reason` per row instead of a bare integer.

And the product does not use it. `listOpportunities` orders by
`[{ scoreValue: "desc" }]`. So the board an SEO reads is ordered by the scorer
that multiplies provider volume into a click estimate — the one behaviour path 2
was written to forbid.

### 5.2 `computeScore` has three defects, measured

**(a) The readiness band is the most generous path, and it ignores severity.**

A row that is `readiness: "actionable"` with `measurement: "unquantified"` takes a
band path *before* the technical branch:

```
strength = freshness * stability * legMultiplier * (0.5 + businessValue/2)
score    = min(30, round(strength * 30))
```

On inmersion's "Missing structured data on 48 pages": `0.999 * 0.8 * 1.0 * 0.95 = 0.76`, × 30 = **23**.
Severity is never read:

```
severity 0.05 → 23
severity 0.30 → 23
severity 0.95 → 23
```

The same defect with a *measured* demand takes the technical branch and scores 6.
So **work with no demand evidence scores four times higher than the same work with
demand evidence**, and the input that should order defects is ignored.

The fix is a guard, not a new formula: the band path must not claim rows whose
`technical` flag is set. The technical branch already reads `severity` and `reach`
correctly (`4 + 6*severity + 4*reach`) and already produces a sane ordering when
it is reached — 6 for a WARNING-severity schema gap, 14 at CRITICAL. Nothing needs
inventing; the generous path simply has to stop intercepting.

**(b) `businessValueSource` is absent on 84% of rows, so relevance quarters almost everything.**

`relevance = businessValueSource === "knowledge" ? 1 : 0.25`.

Measured: `knowledge=194, unset=1654, unknown=117`. `proposalScoreInputs` — the
function that builds every *generated* proposal's inputs — never sets the field at
all. On real rows:

```
apnea article, as stored            7
apnea article, if source known      22
schema hygiene, as stored          23
schema hygiene, if bv were 0.25    15
```

The same work is worth 7 or 22 depending on provenance metadata the writer never
writes. For most of the board, the score is decided by a missing join.

**(c) `estimated` and `measured` compete on one scale.**

`estimated` + `provider_volume` produces `volume × 4% CTR at position 10`:
alaguillotine's hub gets 129,990 × 0.04 = **5,199 clicks**. `measured` +
`first_party_impressions` produces real impressions × a CTR delta: 'alex karp
height' gets 76 × … = **2.85**. A forecast is compared to a receipt, and the
forecast wins by three orders of magnitude.

`ASSUMED_WIN_PROBABILITY_CEILING = 40` was intended to handle this. It caps
fully-assumed rows at 38 — under the ceiling, and still above every measured row.

## 6. The decisions this document makes

These are the three questions the SEO review raised, answered as architecture.
Each is a contract, not a preference.

### D1. Evidence class orders the board; the score orders within a class

`assessment.kind` already exists (`measured | estimated | technical | hypothesis`)
and `evidenceCompleteness` already exists (`why | how | both | none`). Neither
gates anything today.

**The board order is: `measured` → `estimated` → `hypothesis`.** Within a class,
by score. A projection never displaces a measurement, and a row says which class
it is in, next to its number.

This is the review's "missing evidence is not negative evidence" applied to
ordering rather than to weighting: an `estimated` row is not punished for lacking
measurement, it is placed where its confidence belongs.

### D2. A defect is admitted to the board only when the page it affects carries demand

Hygiene does not compete for a slot with revenue work. A defect is ranked when the
affected page has measured impressions, or belongs to a cluster being drafted.
Otherwise it is a health-report line with a count, not an opportunity.

It carries `severity` and `reach` and is ordered by them — never by a click
estimate it does not have, and never by the readiness band, which must not apply
to technical work at all.

> Rationale, as an SEO would put it: nobody chooses between "fix 48 pages of
> schema" and "write the apnea article". They fix hygiene when it blocks
> something. Ranking it first spends the one slot a person reads.

### D3. Discovery is a candidate lane, resolved by buying one SERP

A proposal with no page and no SERP is a hypothesis, not an opportunity.
`expectedClicks` is `null` for it and it is labelled as such. The tranche's top N
hypotheses get a SERP bought ($0.004 each) and become `estimated` with a real
competitive read. Only then do they compete.

This replaces the current behaviour, where such a row is scored as if its
provider volume were reachable — which is how a page that does not exist scores
38 while a page ranking 29th scores 1.

### D4. `businessValueSource` must be written, not inferred

`proposalScoreInputs` sets `businessValue` from the cluster's relevance and never
records where it came from. The model already judges relevance per cluster; the
provenance must be carried with it. A row whose provenance is genuinely unknown
is `needs_investigation`, not a 0.25 multiplier — unknown and known-low are
different states, and damping an unknown is the same error the review names for
competitiveness.

### D5. One stored score, one ordering, and it is refreshed when its inputs change

Three separate things have to hold, and today none of them does.

**(a) One writer.** `proposalPriority` becomes the source of `scoreValue`.
Paths 3 and 4 are deleted. Stored scores are recomputed in a backfill; the
reordering is expected and accepted.

**(b) One ordering.** `scoreValue: "desc"` is currently written in **four** places
that can disagree:

| location | what it orders |
|---|---|
| `lib/funnel/views.ts:443` | the board — the product |
| `lib/research/opportunities-stage.ts:191` | "top 5" in the run report |
| `lib/funnel/serp-watch-list.ts:125` | the watch list |
| `lib/funnel/detectors.ts:1595` | `applyOpenCap`'s overflow |

The board is only one of four surfaces that assume the same meaning. Change
`computeScore` and three of them silently keep the old semantics. `comparePriority`
must be exposed as a single ordering function that all four call, and the four call
sites must be tested together — otherwise D1/D5 reorders the board and leaves the
cap parking the wrong rows.

**(c) Recompute when the inputs change.** `scoreValue` is computed once, inside
`writeOpportunity` (`lib/funnel/opportunity.ts:96`), and never again. `lastScoredAt`
is written but nothing re-scores. So a row's score is frozen at the evidence it had
when it was first written: when a later bundle supplies impressions, a competitor
position or a measured reach, **the stored score does not move**.

This is the fourth structural defect and it was not in the first version of this
document. It is why "re-run the month and the board reorders" does not happen
today; the pipeline rewrites proposals, but a row that is not re-proposed keeps its
old number. The backfill in (a) is a one-off that would decay the same way without
this.

This is PIPE-7 and #233 as one change, because they are one change.

## 7. Legacy inventory

What is dead, what is duplicated, and what to do. "Orphan" means nothing outside
its own test imports it.

### 7.1 Delete — no application caller

Measured 2026-11-25: every module below has **zero** callers in `lib/`, `app/`,
`scripts/` or `components/`. Most are referenced only by their own test, which
means part of the suite is testing dead code — deleting the module means deleting
its test too, and the test count will fall. That is the correct outcome, not a
loss of coverage.

| module | referenced by |
|---|---|
| `lib/ai-seo/opportunity-priority.ts` | its test only |
| `lib/research/score-reconciliation.ts` | its test only (superseded by D5) |
| `lib/research/intelligence-view.ts`, `intelligence-overview.ts` | their tests |
| `lib/research/ai-visibility-import.ts`, `ai-visibility-capabilities.ts` | their tests |
| `lib/pipeline/results.ts` | 2 tests |
| `lib/pipeline/overview.ts`, `findings.ts` | their tests |
| `lib/google/index.ts` | 1 test |
| `lib/design-tokens.ts` | nothing |
| `lib/social/publish.ts` | 2 tests |
| `lib/work/service.ts` | 1 test |
| `lib/reports/monthly-site-evidence.ts` | nothing |
| `lib/dataforseo/keyword-run-view.ts`, `ai-mentions-cadence.ts` | their tests |
| `lib/crawler/schema-semantics-persistence.ts` | 1 test |
| `lib/recommendation/evaluation-manifest.ts` | 1 test |
| `lib/aeo/perplexity.ts` | 2 tests — the AEO path moved to DataForSEO |
| `lib/aeo/observation.ts`, `observation-types.ts`, `cap.ts`, `brand.ts`, `run-types.ts`, `question-set-types.ts` | their tests, or nothing |

Twenty-seven modules. The whole `lib/aeo/` Perplexity-era set is dead: AEO now runs
through `lib/dataforseo/google-ai-overview-collection.ts`.

### 7.2 The legacy freeze is a live landmine — do not enable it

`lib/db.ts` wraps the Prisma client in `withFrozenLegacyFunnel` when
`CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict`. Its comment says the freeze is for "the
cutover release" and that legacy producers still own those tables until their
replacements exist. **That is no longer true, and the flag would break the
pipeline.**

`FROZEN_FUNNEL_MODELS` includes `researchRun`. `researchRun` is now written by
**8 live modules** — `topic-map-stage`, `opportunities-stage`, `monthly-bundle`,
`weekly-refresh`, the pipeline itself. Every bundle, map and proposal run writes a
`ResearchRun` row. Enabling the flag in a "cutover" would make the entire monthly
pipeline fail its writes.

| frozen model | live writers | verdict |
|---|---|---|
| `researchRun` | **8** | the freeze is wrong for this model now |
| `researchSource` | 0 | genuinely legacy |
| `researchFinding` | 0 | genuinely legacy |
| `rankSnapshot` | 0 | genuinely legacy |

The other frozen models are correctly legacy. So the fix is not to delete the
mechanism but to **remove `researchRun` from the freeze list**, and to delete the
three models that are genuinely unused — after confirming nothing reads them.

This is the single most dangerous item in the inventory: a documented,
tested, plausible-looking switcheroo that would take down the pipeline at exactly
the moment someone follows the comment and enables it.

### 7.3 Reachable, needs a trace before removal

These have real app callers, so removal needs a trace, not a grep:

- `lib/funnel/views.ts` (7 callers) — the board read model. Keep; it is the product.
- `lib/funnel/decision.ts` (5) — the pre-contract decision path.
- `lib/recommendation/*` (11 files, `projection.ts` has 4) — still writes `scoreInputs`.
- `lib/pipeline/{results,overview,findings}` (0 app callers) — a second read model
  beside `views.ts`; already counted as dead in §7.1.
- `lib/funnel/legacy-freeze.ts` (3) — see §7.2.

### 7.4 Data to repair

| item | count | action |
|---|---|---|
| `keyword_universe_membership` rows pointing at deleted clusters | 2,645 | delete or annotate |
| `Opportunity` rows with `businessValueSource` unset | 1,654 | backfill under D4 |
| `parked` rows with `score_below_threshold` | 1,734 in total parked | re-score under D5, not delete |
| stored `scoreValue` on all rows | 1,965 | recompute under D5 |

### 7.5 A second pipeline contract describes a different pipeline

`docs/pipeline-stage-contract.md` describes **Business → Research → Findings → Work
→ Results**, driven by `lib/pipeline/stages.ts` and rendered by
`components/pipeline/pipeline-navigation.tsx`. That is a *navigation* contract: it
orders the UI's tabs and it is live (3 callers).

`runResearchPipeline` (`lib/research/pipeline.ts`) is a *job* contract: bundle →
topic-map → opportunities, gated on state.

They are not in conflict — one is where a person clicks, the other is what runs —
but neither document says so, and a reader who opens the stage contract looking for
the monthly order will not find it. §3.3 of this document is the job contract. The
stage contract should gain one sentence pointing here.

### 7.6 Documentation to retire

`docs/README.md` lists as active: `seo-funnel-spine-plan.md`,
`demand-map-cluster-discovery.md`, `ds-02-run-unification.md`,
`wave6-cleanup-ledger.md`. Each describes a stage the pipeline has since replaced.
Move them to `archive/` and point here instead. `pipeline-stage-contract.md`,
`pipeline-lineage-contract.md` and `pipeline-configuration-contract.md` stay and
should reference §3.

## 8. Order of work

Each step is independently shippable and independently verifiable. Do not fold
D5 into a cleanup PR — it reorders every board.

1. **Audit the orphans** (§7.1) — delete, with the wiring test extended to catch a
   re-added producer. Cheap, no behaviour change.
2. **D2, the hygiene gate** — removes wrong work from the board rather than
   reordering it. Verify: inmersion's schema row leaves the top four. **Note:** there
   is no separate health surface today — `lib/crawler/health.ts` computes a score but
   no view renders the defect list outside the board. So D2 needs a destination for
   the row, not just a filter, or the information disappears. Ship the destination
   with the gate.
3. **Fix the band (5.2a)** — guard the band path so a `technical` row cannot take it,
   and let the technical branch order defects by `severity` and `reach` as it already
   does. Verify: the same defect scores the same whether its demand is quantified or
   not, and severity moves it.
4. **D4, `businessValueSource`** — write it, backfill it, and replace the 0.25
   default with an explicit unknown state. Verify: apnea's score no longer depends
   on a missing field.
5. **D3, the candidate lane** — hypotheses are labelled and unbought until the
   tranche pays $0.004 to resolve them.
6. **D5, one scorer** — the big one, last, with its own board reorder accepted.
   Contains three sub-steps that must not be split: one writer (the backfill), one
   ordering function called by all four surfaces (§D5b), and recompute-on-change
   (§D5c). Shipping only the backfill produces a board that is correct for one day.

## 9. What must not be built

- **A site-maturity flag.** alaguillotine is new and has the same disease as
  casamigo, which is not. The three defects are all "the scorer does not know what
  kind of evidence it holds". A maturity mode would be a per-tenant branch and it
  would misfire where the evidence is strongest.
- **A second board.** One board, ordered by one contract.
- **Inflating a discovery score.** The review is right that missing ≠ negative;
  that is resolved by labelling and by placing, not by adding points.
- **Tuning `openCap`.** It is a detector safety valve (100), not a month's work.
  The tranche (T4) decides what a month is.

## 10. Open, undecided

- **How many candidates the tranche resolves per month.** Depends on the cap and
  on `BUNDLE_CAPS.serpQueries: 10`. A number, not a principle; decide with T5.
- **Whether `technical` work gets its own board face or a health section.** D2 says
  it does not compete; where it is *shown* is a UI decision.
- **`marketScope` for a site selling across borders.** inmersion's 10 clusters are
  all `international`; plausible for a trilingual school, unverified. Needs an SEO
  read on one tenant before it is trusted.
- **What triggers a re-score, and how often.** §D5c says a stored score must follow
  its inputs, but not who calls it: every bundle? every evidence write? a nightly
  job? Recomputing 1,965 rows is cheap, but the trigger decides whether the board is
  current by the time a person reads it. Decide with D5, not after.
- **Whether `applyOpenCap`'s overflow should be ordered by the same class-aware
  ranking.** It parks beyond 100, so a class-aware order changes *which* rows park,
  not just which are shown. That is a real behaviour change inside D5.
