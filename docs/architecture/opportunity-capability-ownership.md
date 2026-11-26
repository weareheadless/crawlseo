# Opportunity capability ownership

Who produces each kind of opportunity, who may change its state, and what happens when a
capability cannot run. This is the contract; `lib/funnel/capabilities.ts` is its only
implementation, and `tests/opportunity-capability-ownership.test.ts` plus
`tests/capability-ownership-bound.test.ts` are what stop it drifting.

Read `docs/architecture/opportunity-board.md` first for the D1–D5 board contract. This document
covers the layer underneath it: which producer is accountable for which row.

## The problem this exists to prevent

The board has one table and two producers:

- the **topic map** (`phase3:topic-map`) — model proposals derived from the demand map, and
- the **detectors** (`runDetectors`) — arithmetic over stored evidence.

They are complementary, not alternatives. The topic map emits 5 of the 14 declared opportunity
types; the detectors emit all 14 and own the 9 the map cannot express.

Until 2026-11-25 ownership was never declared. It was inferred from a comment in
`refreshFunnelForSite` — *"one board per project; a modelled project's board is the topic map's,
the legacy detectors would add a second, differently-reasoned list of work"* — and from whichever
producer happened to run last. That inference was implemented as an early return: when a project
had modelled clusters, `runDetectors` did not run at all.

All 8 tenants had modelled clusters. So no detector ran in production for any of them, and nine
capabilities had no producer:

| Capability | Type | Required evidence |
| --- | --- | --- |
| Winnable rank | `O1_winnable_rank` | `keyword_rank` |
| Striking distance | `O2_striking_distance` | `keyword_rank` |
| AEO presence gap | `O5_aeo_presence_gap` | `question_coverage` |
| Business fact mismatch | `O6_business_fact_mismatch` | `onpage_crawl`, `knowledge_fact` |
| Structured data gap | `O8_structured_data_gap` | `onpage_crawl` |
| Backlink gap | `O9_backlink_gap` | `backlink_profile` |
| Keyword cannibalisation | `O10_cannibalization` | `keyword_rank` |
| Page experience | `O12_page_experience` | `vitals` |
| User pain point | `O13_user_pain_point` | `research_finding` |

The companion defect was retirement: `retireLegacyOpportunitiesForTopicMap` parked every legacy
row regardless of type, filing **109 rows** of capability the topic map cannot express as
"superseded by the topic-map pipeline" — striking distance 31, user pain point 30, winnable rank
28, structured data 15, cannibalisation 4, backlink gap 1.

Both looked like success. The run reported `opportunities are owned by the topic map`, and the
census showed a healthy board, because the missing work was *missing* rather than *failed*. That
is the mechanism behind "one step forward, two steps back": a new producer takes over the board,
and the capabilities it cannot express are deleted by the takeover rather than handed to it.

## The rule

**Ownership is a property of the capability, not of the writer.**

`detectedBy` records which run wrote a row. There are 23 distinct values in production —
`funnel-refresh`, `tenant-analysis`, `crawl-job`, `batch-reanalysis`, and 19 others, most of them
one-off analysis and verification scripts that will never run again. Scoping a state transition
by `detectedBy` therefore strands every row those writers left behind: nobody can maintain it, so
it stays `detected` forever, showing findings no current run still sees. Stale work presented as
current is the same defect as hidden work.

Scoping by capability means the current owner maintains its predecessors' rows, and no producer
can touch work it does not own.

A producer may create rows of, and change the state of rows of, **exactly the types it owns**.
That bound applies to every sweep: hysteresis (both the park leg and the restore leg), the open
cap, and the stale-row retirement. Nothing else — not a "cleanup", not a resource limit, not a
migration.

## Ownership table

`CAPABILITY_PRODUCER` in `lib/funnel/capabilities.ts` is the single declaration. The topic map
owns:

`O3_content_gap`, `O4_aeo_citation_gap`, `O7_technical_defect`, `O11_freshness_decay`,
`O14_offer_positioning_gap`

The detectors own the other nine, listed above.

The partition is checked, not maintained by hand:
`opportunityTypesTheTopicMapCanProduce()` derives the topic map's set from its own
`TYPE_FOR_PROPOSAL` map, and the test fails if the two disagree, if any capability has no owner,
or if any has two. Adding a proposal lane that maps to a new type fails the suite until someone
decides explicitly whether the detector for that capability should stand down.

## Production

`runDetectors` takes `topicMapOwnsBoard`. When true it produces only the nine detector-owned
types and stays out of the map's five — that is the "one board per project" rule, correctly
scoped, and it is what stops two producers reasoning differently about the same finding from
showing it twice. When false the project has not been modelled, so every detector runs and an
unmodelled tenant bootstraps rather than getting an empty board.

`refreshFunnelForSite` no longer returns early. It retires the map-owned legacy rows, then runs
the detectors for their own capabilities, and merges the results.

## Absence is a number

A capability that cannot run must say so. `runDetectors` reports `disabled`: the owned types it
could not produce, each with the evidence kind that is missing.

    O9_backlink_gap    missing: backlink_profile
    O12_page_experience missing: vitals

`refreshFunnelForSite` carries that list out instead of dropping it, which is what makes
"this tenant has no backlink data" distinguishable from "this tenant has no backlink problems".
Only owned types are reported: saying `O3_content_gap` is disabled beside a board full of the
topic map's O3 rows would be a false alarm, because O3's producer is the map and the map has its
own evidence needs.

There is no fourth state. Every capability is either on the board, visibly reported as unable to
run with the missing input named, or declared retired with a stated replacement.

## Consequences worth knowing

**The open cap is now per producer.** `applyOpenCap` bounds the rows its own producer wrote, so
turning one producer on cannot evict the other's rows to make room. A limit on how much work the
owner is shown is a display concern; enforcing it by deleting another producer's work is how
capabilities vanish. Total open rows on a project can therefore exceed `openCap`, bounded by the
number of producers rather than by one global figure.

**The stale sweep crosses writers within a capability.** A run that emits `O2_striking_distance`
maintains every `detected` O2 row on the project, including ones written by
`batch-reanalysis` in 2026-11. A run that emits nothing for a type leaves that type alone —
`produced` only holds types the run actually emitted, so "this detector found nothing" and "this
detector could not run" stay different claims.

**Human decisions are never swept.** Every bound above applies to `status: "detected"`. An
accepted, in-progress or human-parked row is untouched by hysteresis, the cap, retirement and the
stale sweep alike.

## Measured effect

Dry runs over all 8 tenants before deploying, counting only detector-owned types: 365
candidates, **83 reaching the board** at the hysteresis threshold of 3, and no candidate leaking
into a topic-map-owned type.

| Tenant | Candidates | On board | Composition |
| --- | --- | --- | --- |
| susimacdonald | 173 | 49 | 26 striking distance, 18 winnable rank, 4 cannibalisation, 1 structured data — 43 `measured` |
| atelier-harmonie | 95 | 15 | 8 winnable rank, 5 striking distance, 1 cannibalisation, 1 structured data |
| oceanicvibes | 15 | 9 | 8 user pain point, 1 structured data |
| alaguillotine | 24 | 5 | 2 winnable rank, 2 user pain point, 1 structured data |
| astridrincon | 21 | 4 | 4 user pain point |
| casamigo | 13 | 1 | 1 structured data |
| inmersion | 12 | 0 | — |
| superincompetence | 12 | 0 | — |

The 282 that park were checked rather than assumed. 211 are queries under 20 searches a month.
The largest is `"hospital near me"` at 1.22M searches/month on a personal Wix site — the exact
accidental head term the relevance damper exists to refuse, and it correctly scores 1 and parks.
96 of susimacdonald's 173 candidates resolve a cluster; the 64 that do not are genuinely outside
the topic map's 374 mapped queries, so their damped relevance is honest rather than a wiring
failure.

## Adding a capability

1. Add the type to the `OpportunityType` enum.
2. Add its owner to `CAPABILITY_PRODUCER`. The suite fails until you do — a type with no owner is
   a capability nobody produces.
3. Declare its evidence in `DETECTOR_REQUIRES`, so its absence is nameable.
4. If the topic map owns it, add the lane mapping to `TYPE_FOR_PROPOSAL`. The ownership test
   derives from that map, so the two cannot disagree.
5. If a detector owns it, write the detector and add it to `DETECTORS`.

Do not add a producer-specific branch, a tenant flag, or a second retirement path. If a rule needs
an exception for one tenant, the rule is wrong: the exception belongs in the tenant's data or in
the model's prompt.
