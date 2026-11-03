# SEO improvement funnel — spine plan

Status: **proposed spec** (owner-ratified 2026-11-02 in working sessions; publication PR pending review)
Supersedes: the *no schema migration* stance of `docs/pipeline-implementation-plan.md` (PIPE-07). The pipeline read-model contracts (`pipeline-stage-contract.md`, `pipeline-lineage-contract.md`, `pipeline-configuration-contract.md`) remain descriptive of the current system until the cutover in this plan; they are then frozen read-only with the legacy tables.
Re-scopes in place: [DS-10 (site-agent#476)](https://github.com/weareheadless/site-agent/issues/476), [DS-17 (crawlseo#139)](https://github.com/weareheadless/crawlseo/issues/139) — see §7.

## 1. Why this exists

The DataForSEO track (DS-01…DS-17) assumed the existing evidence/action structure could carry new provider data. It cannot: three parallel run families (`ResearchRun`, `SeoResearchRun`+`SeoResearchTask`, `ArticleKeywordResearchRun`), four unrelated action factories writing one `ResearchAction` table with a free-string `source`, lineage carried in JSON blobs, and `AIVisibilityObservation` joined to findings/actions/deliveries by nothing. The "pipeline" exists as a read-time projection (`lib/pipeline/*.ts`), not as a data model.

The product's strength is the quantity of data we gather, organized to understand customer needs and turned into opportunities to rank. That requires one funnel with one spine. This document defines it so backend schema and UI are one thing, and the DS track is re-planned on top.

Owner decisions applied (2026-11-02):

1. **Clean funnel** — legacy runs/actions/tables freeze read-only; no import onto the new spine.
2. **Opportunities found automatically** — detectors run on the crawl/evaluation schedule; the user decides.
3. **Tasks executed by humans for now** — detection, research and drafting can be agent-driven; execution/publication is human-confirmed. No autonomous publishing in this phase.
4. **One page per opportunity** — the funnel and its reason visible at a glance; no tab/two-page deep-dives.
5. **Business/market research is a first-class evidence source** — the "why" leg; every opportunity scores evidence completeness across both legs (see §2).

## 2. The funnel, stated once

Every piece of work on a site is the end of one chain. The two evidence sources are not parallel alternatives and not a hard gate — they are the two legs the same opportunity stands on:

```
WHY it matters (business/knowledge evidence)  ─┐
                                               ├─ AND (scored) ─→ OPPORTUNITY → TASK → DELIVERY → OUTCOME → feedback
HOW we win it (search/technical evidence)      ─┘
```

- **Signals** are automatic collection: DataForSEO products (keyword data, SERP, rank tracking, OnPage, backlinks, AI Optimization), GSC/GA4/Vitals, our crawler, business knowledge.
- **Evidence** is a typed, normalized observation with provenance (source, time, dimensions, units, cost).
- **An opportunity** is a decision-shaped object: what we could win, why, what it is worth, what playing it costs. Detected automatically from evidence; accepted into work by the human, or parked/rejected with a reason.
- **A task** is work created by accepting an opportunity, executed by a human (agent-assisted). Its "why" is always the opportunity chain.
- **Delivery** is the human-confirmed change shipped, with revision and receipt.
- **An outcome** is a typed before/after observation against a baseline recorded *before* delivery.

User-visible rule: **if you can open a task or opportunity and not see the funnel that produced it, the data model is broken.** If a number appears without declared source/state, the schema is broken.

### 2.1 The demand map — the top of the funnel

Detectors never see raw data directly. Between signals and opportunities sits the **demand map**: the organized, per-project picture of what customers need, how they search for it, and where we stand. It is a *derived, recomputable projection* of evidence (never new truth):

- **Offer/topics** — from business knowledge: services, products, audience, questions customers actually ask.
- **Query clusters** — the keyword universe grouped by need/topic, labelled with intent (informational/commercial/transactional/local) and business relevance (does the offer serve this need?).
- **Tracked grid** — the keyword set we track ranks for, tiered (money, cluster head, longtail sample), with cohorts (ours vs competitors).
- **Competitor set** — who we are measured against per cluster, refreshed from SERP composition, not hand-picked once.
- **Our position** — ranks, visibility share, coverage (which clusters we have content for), citation presence.

The demand map answers "what does the landscape look like"; the opportunity board answers "what do we play next". Every opportunity links to its cluster; the cluster view is the portfolio level. Curation of clusters is LLM-assisted and must obey the same discipline as scoring: declared, auditable inputs, no silent heuristics.

### 2.2 Data acquisition plan (quantity with a purpose)

Collection is tiered by project importance and budget; everything collected has a stated consumer (demand map, detector, or evidence audit). Per project:

| Data | Source | Cadence | Consumer |
|------|--------|---------|----------|
| Keyword universe growth (seed → expansion → question mining → competitor gap) | DataForSEO Keywords/Labs + GSC queries | monthly | Demand-map clusters |
| Rank tracking grid | DataForSEO rank tracking / SERP | weekly | O1/O2/O11 detectors, baselines, share of voice |
| SERP composition + features (snippets, PAA, AI Overviews presence) | DataForSEO SERP API | weekly per tracked cluster | Intent labels, O3 detection, AEO relevance |
| Competitor ranks + backlink intersection | DataForSEO backlinks/intersections | monthly | O9, competitor refresh, authority gap in scoring |
| Full crawl + OnPage | our crawler / DataForSEO OnPage | weekly (configurable) | O6/O7/O8/O10 detectors |
| AI visibility evaluation | LLM / AI-Optimization products | weekly per question set | O4/O5, baselines |
| GSC/GA4/Vitals | native integrations | daily | Worth (CTR), O2/O11/O12, outcome measurement |

Budget rules from DS-08 govern all paid collection; a collection without a consumer does not run.

**Collection is a prerequisite, not a sibling.** A detector whose required evidence kind is absent is **disabled and reported as disabled**, never silently empty. An empty O3 board must mean "no gap", not "no SERP data". Every detector declares its required kind, and the readiness matrix in §9 is the contract; reporting that hides a disabled detector is a bug, not a clean result.

This rule was added after v1 shipped detectors before their collection and read the emptiness as a detector failure (§10).

### 2.3 Scoring (SEO economics, declared and recomputable)

```
score = worth × win_probability / effort          (0–100, displayed with components)
raw   = score × completeness × freshness × stability
shown = 100 × raw / (raw + 1)                     (saturating, so nothing pins at 100)
worth           = volume × CTR-at-position × business_value (conversion relevance from knowledge)
win_probability = f(rank distance, authority gap [referring-domain delta], page strength,
                    SERP composition [strong competitors above us], play type)
effort          = play-type base (schema fix ≪ content update ≪ new page ≪ outreach) × size of change
```

Three multipliers are recorded separately, never folded into one number: **evidence completeness** (which legs hold), **freshness** (evidence age), **stability** (rank oscillation of the keyword/cluster). Detectors fire only above a stated per-type threshold. All scoring inputs are stored, so every score is auditable and recomputable; SERP changes re-score automatically.

`business_value` is derived from knowledge evidence, never a constant:

- `0.9` — a `knowledge_fact` or a winnable-gap `research_finding` names the offer/audience this query serves;
- `0.6` — the cluster is marked business-relevant in the demand map;
- `0.3` — the query only matches the site's topic;
- `0.5` — declared **unknown**, recorded as `businessValueSource: "unknown"` so the board can show why the score is weak.

A page-level defect (O7, O8) has no query demand of its own. Its worth comes from the page's demand (`first_party:impressions`, traffic) or, when that is unknown, from a declared impact weight — **never** from the 120 searches/month fallback. That fallback exists for one-legged query opportunities, and applying it to crawl defects is what made 60 identical structured-data rows outrank everything (§10).

Follow-up joins execute (`lib/funnel/join-runner.ts`): a missing **why** leg is joined from business knowledge when a fact shares a meaningful token with the opportunity, and the join is reported as skipped when nothing matches — never guessed. A missing **how** leg runs its declared collection (keyword volumes for O13, SERP for O14, AI visibility for O5), which is paid, so the automatic path (crawl job, refresh) spends nothing and a human runs `scripts/run-join-followups.ts` with an explicit ceiling.

The legs are scored, not gated: an opportunity with one leg is immediately valid and visible (pipelines leak; a one-legged opportunity is often still the best work available). Follow-up collection runs automatically to join the missing leg and upgrade the score. The board sorts by score, so "worth doing AND winnable" floats to the top without hiding the leaks.

### 2.4 Feedback loop

- Verified wins/losses update win-probability priors per play type and cluster.
- New GSC queries auto-enter the keyword universe (the customer teaches us how they search).
- SERP composition changes re-score affected clusters; the competitor set refreshes from SERPs.
- Question-coverage outcomes grow the question set.

## 3. Opportunity taxonomy

Each type defines: required evidence, default play, success metric, and which leg usually fires first. Adding a type is a schema+UI change, not an improvisation. "Fires from" = the leg whose detector discovers it; the other leg is joined automatically by follow-up collection and lifts the score.

| # | Type | Detection (evidence required) | Fires from | Default play | Success metric |
|---|------|------------------------------|------------|--------------|----------------|
| O1 | Winnable rank (top-10 near-miss) | Rank tracking: our URL positions 4–10, keyword has value | Search | Content update + internal links | Rank delta; traffic delta |
| O2 | Striking distance / zero-click | Rank 8–20, impressions, low CTR | Search | Title/meta/intent rewrite | CTR + rank delta |
| O3 | Content gap vs competitors | SERP analysis: competitors cover subtopics we don't | Search | New page / section expansion (research-assisted) | Keyword/question coverage, impressions |
| O4 | AEO citation gap | AI visibility: question asked, competitor cited, we absent, our knowledge answers it | Both | Answer-format content update targeting the question | Citation present on re-ask |
| O5 | AEO presence gap | Question set never observed for this site | Business | Subscribe question to evaluation schedule | Question unobserved → observed |
| O6 | Business fact mismatch | Crawl content contradicts canonical knowledge | Business | Direct content fix (human-confirmed) | Consistency check passes |
| O7 | Technical defect | Crawl issue with crawlability/user impact | Search | Fix + recrawl verification | Issue count → 0 |
| O8 | Structured data gap | Missing/mismatched identity or product schema | Business(+search) | Schema fix from knowledge | Rich-result validity; O1 follow-up |
| O9 | Backlink/authority gap | Competitor intersection: linking domains we lack | Search | Outreach / content asset play (human) | Referring domains |
| O10 | Cannibalization | Two our-URLs splitting one query | Search | Consolidate/redirect/canonical | Single-URL rank stability |
| O11 | Freshness decay | Page losing position/impressions over time | Search | Refresh cycle | Rank/impression recovery |
| O12 | Page experience | Vitals failure on revenue page | Search | Perf fix | Vitals pass + rank/CTR |
| O13 | User pain point without content | Market/user research: real question/complaint/need with no (or weak) on-site answer and search demand | Business | New content validated by keyword data; if no demand, park with reason | Question coverage; traffic to the new page |
| O14 | Offer/positioning gap | Research + SERP: competitors position an offer we don't articulate (or vice versa) | Business | Content/positioning update | Conversion-relevant metrics + visibility |

O13/O14 are business-leg discovery types: what research findings become when they identify a winnable gap. A finding with no winnable gap stays a finding (context); it never becomes a task.

**Research output contract.** Research must emit *gap-typed* findings to reach the board: `PAIN_POINT`, `CUSTOMER_NEED`, `OBJECTION`, `FRICTION` → O13; `COMPETITOR`, `POSITIONING`, `MARKET_GAP`, `OPPORTUNITY` → O14. `TREND`, `THEME` and `CONTENT_GAP` are context: they can justify a content play but are not a winnable gap until the research states the gap (who needs it, what answer is missing, what demand exists). A run that only returns themes produces no opportunities, and that must be visible in the run's own result rather than inferred from an empty board.

**Not opportunities:** raw keywords, raw SERP rows, issues without impact, metrics with no winnable story. Those are evidence; they become opportunities only through a detector with a stated rule.

**Cluster layer.** Every opportunity belongs to a demand-map cluster; cluster roll-ups show how many open opportunities share a topic. A detector may emit a **cluster opportunity** (e.g. "cluster head X covered by competitors in 5 subtopics — build a topic hub") that one delivery closes several atomic opportunities for. Delivery links back to every opportunity it serves.

**Detector hygiene (enforceable, not aspirational).**

- **Per-type minimum evidence.** O1 volume ≥ 10; O2 impressions ≥ 10 *and* low CTR; O3 ≥ 2 competitor subtopics; O7 only when the issue has crawlability impact *and* either the page has recorded demand or the same issue spans ≥ 3 pages; O8 one opportunity per page; O9 referring-domain gap ≥ 3; O13/O14 confidence ≥ 60 *and* a winnable-gap finding type.
- **Grouping.** Page-level issues are one opportunity per page. When ≥ 10 pages share the same issue type, the detector emits **one site-level opportunity** listing the pages, so one delivery closes them.
- **Cap.** At most 100 open opportunities per project. Overflow parks with `parkReason: "cap"`, score-sorted; nothing is deleted.
- **Dedup/merge.** Same (type, url | query) is one opportunity; edges merge.
- **Hysteresis.** Below the type's minimum, `detected` parks with a reason, no flickering.

A detector that cannot meet its minimum because the evidence is absent is **disabled** (§2.2), which is reported differently from "fired and found nothing".

## 4. Backend schema (the spine)

Principles: one entity per stage; typed edges, not JSON; raw payloads immutable in their own store; reads never mutate; every stored metric carries source/units/dimensions/state.

### Entities

- **RawProviderResponse** — provider, product, endpoint, task id, locale, requested_at, delivered_at, cost_micros, status, payload (immutable). The one raw store; normalized tables never store raw blobs again.
- **EvidenceRecord** — typed normalized observation. `kind` enum (keyword_rank, keyword_metrics, serp_snapshot, serp_features, intent_label, competitor_rank, backlink_profile, share_of_voice, keyword_universe_membership, onpage_crawl, internal_link_graph, ai_visibility_observation, gsc_query, gsc_page, vitals, analytics, knowledge_fact, question_coverage, research_finding), project-required/site-optional, observed_at, freshness, source FK, dimensions, typed metrics, `superseded_by`. Research findings are evidence of a declared kind — the two legs share one envelope.
- **Opportunity** — `type` enum O1–O14, `status` (detected → accepted → in_progress → parked → rejected → closed), score with declared recomputable inputs (evidence completeness, strength, freshness, worth — each component stored), dimension, cluster FK, summary, first_detected_at, decided_by (human).
- **EvidenceEdge** — generic typed edge with `relation` (supporting, contradicting, baseline, produced_by, superseded_by). This *is* the lineage; no IDs-in-JSON.
- **Task** — REQUIRED `opportunityId`, REQUIRED human executor (agent assistance recorded). States: `todo → in_progress → awaiting_human → delivered → verified_outcome`. No autonomous publication path in this phase.
- **ResearchRun** — unified table, `kind` enum (market_research, keyword_data, serp, onpage, aeo_evaluation, …). Findings link to evidence records. New runs only.
- **Baseline** + **OutcomeObservation** — pre-delivery baseline for the task's success metric; post-delivery typed delta with `verdict` (verified_win, no_effect, regression, unmeasured, pending).
- **DemandMap projection** — recomputed views over EvidenceRecord (clusters, intent, coverage, share of voice, competitor set). Derived, never authoritative.

Retired (frozen read-only, not migrated): `RankSnapshot` duplication, run-table counters, per-family run tables, free-string `source`, JSON evidence blobs.

### Invariants (checked in code, documented as contracts)

1. No orphan tasks: `Task.opportunityId` NOT NULL.
2. Opportunities are visible with one leg (no gate); the score's evidence-completeness component shows which legs hold; acceptance is the human's call at any completeness level.
3. No evidence without provenance: producer, time, and (when paid) raw response + cost.
4. Detection is automatic: every O-type has a scheduled detector; manual creation is not part of the primary flow.
5. Reads make zero paid calls; refresh is scheduled.
6. Observed zero ≠ no measurement; unsupported markets stay unknown.
7. Provider-sourced and first-party metrics never share a label.
8. One semantic per field; counters derived, not stored.
9. Outcomes require a pre-delivery baseline; no baseline ⇒ `unmeasured`, never estimated.
10. Old versions are superseded (`superseded_by`), never deleted.
11. Scope is single: project-required, site-optional — no double scoping.
12. Every human-execution step records who confirmed; agent-prepared artifacts are distinct from human-confirmed ones.

## 5. UI (1:1 with the schema)

Primary navigation *is* the funnel. Tools live inside stages; legacy routes freeze.

1. **Overview** (`/sites/[siteId]`) — stage counts by dimension, trending verdicts, top open opportunities, recent deliveries. Everything links into its stage.
2. **Demand map** (`/demand`) — the landscape: clusters with intent, business relevance, coverage, visibility share, tracked grid, competitor set. Cluster detail is the portfolio roll-up (open opportunities, which delivery closes several at once).
3. **Opportunities** (`/opportunities`) — the home of the funnel. Board sorted by score (components expandable), filter by type/dimension/status/missing leg. Row = what, why (one line of top evidence), worth, cost, status, age. Accept/park/reject here (bulk supported).
4. **Work** (`/work`) — human task list by opportunity type and execution state; agent-prepared artifacts surface as `awaiting_human`.
5. **Opportunity/task detail — ONE page** (`/opportunities/[id]`) — vertical chain, no tabs: why this exists (decisive evidence from both legs, source badges, score) → plan (default play, who executes) → research (collapsible) → delivery (revision, receipt, who confirmed) → outcome (baseline vs after, verdict, next re-check). Missing stages render their lifecycle reason; deep detail expands inline or links to Evidence.
6. **Evidence** (`/evidence`) — searchable store by kind/source/time; audit trail for provenance and spend; sanitized raw drill-down.
7. **Tools** (keyword research, SERP explorer, crawl, backlinks, AI visibility) — evidence producers; primary CTA is "add/refresh evidence"; anything actionable lands as an Opportunity.
8. **Business/Research** — the "why" leg surfaces: research requests, runs, findings, question coverage. Winnable-gap findings surface as O13/O14 on the same board.

UI invariants: every metric carries a source/state/unit badge; one page per opportunity; empty states are lifecycle statements; no screen launches paid work implicitly.

## 6. Cutover

- Legacy research/run/action tables and their UI routes freeze read-only (a "Legacy" link may expose them).
- New funnel entities start empty; detectors backfill opportunities from usable stored evidence (raw SERP/rank data), otherwise from the next scheduled crawl/evaluation.
- Nothing is deleted; legacy remains queryable for audits and spend reconciliation.
- Non-blocking micro-decisions during implementation: parked-opportunity expiry, per-type win thresholds.

## 7. Effect on the DS track

- **DS-01, DS-02, DS-07, DS-08** keep their place (capability verification, orchestration, credentials, budget) — spine-adjacent, run in parallel.
- **DS-03** is absorbed into the spine waves (raw store, EvidenceRecord/Edge, unified runs).
- **DS-04 (OnPage), DS-05 (one semantic per field), DS-06 (AI visibility), DS-14 (refresh scheduling)** re-plan on the spine; acceptance criteria mostly survive, migration contracts rewritten for the new entities.
- **DS-10 (site-agent#476)** and **DS-17 (crawlseo#139)** re-scoped in place on 2026-11-02 (see the re-scope section in each issue body): DS-10 serves the demand-map/opportunity projections; DS-17 consumes scored opportunities (never re-scores) and outputs drafted plans in `awaiting_human` state, including cluster plays.
- **DS-09/11/12/13/15** unchanged in intent; fixtures rewritten against the spine.
- New work items: raw store; demand-map projection; detectors O1–O14; task gate + human state machine; baselines/outcomes; UI rebuild; cleanup ledger.

## 8. Cleanup ledger — delete the improvised scaffolding

Cleanup is its own wave; every deletion requires a migrated consumer or a frozen read-only cutover, and is recorded (checked off) so it is auditable:

1. The four orphan action factories as task creators: `lib/dataforseo/prelaunch-actions.ts`, `lib/research/keyword-actions.ts`, `lib/research/seo-actions.ts`, `lib/research/crawl-actions.ts`, `lib/crawler/technical-actions.ts` — replaced by detectors; task creation moves to the single gate.
2. Read-model lineage reconstruction: `lib/pipeline/lineage.ts` + `lineage-types.ts` gap machinery — replaced by EvidenceEdge reads.
3. Duplicated run tables: `SeoResearchRun`, `ArticleKeywordResearchRun`, the prelaunch split.
4. `RankSnapshot` and stored counters (`ResearchRun.actionCount/findingCount/sourceCount`) — recomputed as views.
5. JSON-blob lineage: `ResearchAction.evidence`, `ResearchFinding.evidenceSourceIds`.
6. Stale UI scaffolding: filter/tab pile-ups, two-page task views, empty-shell pages, the unlabelled precedence overlay in `rank-history`, duplicate/predecessor routes.
7. Free-string `source` on actions and any "global pipeline" view mixing stages in one list.

## 9. Wave plan

- [ ] Wave 0 — Raw store + evidence record schema (clean tables, legacy frozen read-only)
- [ ] **Wave 0.5 — Collection enablement (§2.2).** For each evidence kind: a producer, a cadence, a budget, and **one real payload verified**. This wave is not done because an adapter exists; it is done when the kind has rows from the provider. A detector stays disabled until its kind is present.
- [ ] Wave 1a — Demand map (clusters, tracked grid, competitor set) + Opportunity entity + lineage edges + missing-leg join scheduler
- [ ] Wave 1b — Detectors O1–O14, each enabled only when its evidence kind is present. The readiness matrix below is published with the wave, and a disabled detector is reported as disabled.
- [ ] Wave 2 — Task contract: task originates from an opportunity; human-executed workflow states
- [ ] Wave 3 — Measurement spine: baselines, outcome observations, AEO joins
- [ ] Wave 4 — UI rebuild mapped 1:1 to the schema (single-page opportunity view)
- [ ] Wave 5 — Re-scope and resume the DS track on the new spine (DS-04/05/06 adapters)
- [ ] Wave 6 — Cleanup: delete the improvised scaffolding (§8 ledger)
- [ ] Cutover: freeze legacy tables read-only, switch read paths, archive the old UI routes

**Detector readiness matrix.** Each detector names the evidence kind it needs. If the kind has zero rows, the detector is disabled and the board says so.

| Detector | Needs | Enabled when |
|---|---|---|
| O1 winnable rank | `keyword_rank` carrying a volume metric | rank rows exist **with** volume |
| O2 striking distance | `keyword_rank` with impressions ≥ 10 | GSC rows carry impressions |
| O3 content gap | `serp_snapshot` | SERP collection ran for a cluster |
| O4/O5 AEO | `ai_visibility_observation`, `question_coverage` | AI visibility collection ran |
| O6 fact mismatch | `onpage_crawl` + `knowledge_fact` | business knowledge ingested |
| O7 technical defect | `onpage_crawl` (crawlability impact) | crawl completed |
| O8 structured data | `onpage_crawl` (schemaMissing) + `knowledge_fact` for the why leg | crawl completed; why leg needs knowledge |
| O9 backlink gap | `backlink_profile` / competitor intersection | backlink collection ran |
| O10 cannibalization | `keyword_rank` (two URLs, one query) | rank rows exist |
| O11 freshness decay | `keyword_rank` time series | ≥ 2 observations per query |
| O12 page experience | `vitals` | vitals sync ran |
| O13/O14 | gap-typed `research_finding` | research emitted gap findings (§3) |

Each wave becomes bounded work items with claims, tests and the standard release gates in `docs/agent-coordination.md`. No task claim, spend, migration, merge or production release is authorised by this document alone.

## 10. v1 drift audit (2026-11-03)

The first implementation of this plan was structurally faithful and substantively empty. Recorded here so the fix is traceable and the sequencing rule in §2.2 is not quietly dropped again.

What v1 did: it treated Wave 1 (detectors) as independent of §2.2 (collection), and shipped the detectors before any SERP, backlink, AI-visibility, keyword-volume or business-knowledge evidence existed.

Observed on atelier-harmonie.com (project `cmulsoose000soyqfuk5fji4m`):

| Spec | v1 reality |
|---|---|
| §2.2 SERP weekly → O3 | 0 `serp_snapshot` rows |
| §2.2 AI visibility weekly → O4/O5 | 0 `ai_visibility_observation` rows |
| §2.2 backlinks monthly → O9 | 0 backlink evidence |
| §2.2 keyword volumes | 4 `keyword_metrics` rows for 113 tracked queries |
| §2.3 `business_value` from knowledge | hardcoded 0.5 / 0.6 in every detector |
| §3 per-type thresholds | O7/O8 had none; O2 fired at `impressions > 0` |
| §3 open cap | none; 170 open opportunities |
| §3 "issues without impact" | one opportunity per page per crawl issue |
| §2.3 automatic leg join | `join.ts` computes follow-ups; nothing executes them |

Result: 170 opportunities, **0 with a why leg**, scores 33/18/0 by type, 140 of them page-level crawl defects. The board was sorted by a fabricated 120 searches/month applied to technical issues, so it looked like the funnel only ever proposes structured data.

Three causes, in order of size:

1. **Sequencing.** Wave 1 was defined without its §2.2 prerequisites. Fixed by Wave 0.5 and the readiness matrix.
2. **Approximations.** Business value, thresholds, cap and grouping were implemented as placeholders. Fixed by the enforceable §3 rules.
3. **Data.** Business knowledge is 0 documents; the research we have is `TREND`/`THEME`/`CONTENT_GAP`, which §3 now states cannot become an opportunity without a gap statement. Fixed by the research output contract, not by a new detector.
