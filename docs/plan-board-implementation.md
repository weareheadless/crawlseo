# Implementation plan: make the board tell the truth

Follows `docs/architecture/opportunity-board.md`. That document decides *what* is
right; this one is *how and in what order*, one shippable step at a time.

**Rule for every step:** land it alone, verify it on the four measured tenants, and
say what changed on a real board. A step that cannot be verified from a board is a
step that is not finished.

## The four boards each step is judged against

Measured 2026-11-25. Use these specific rows as the acceptance fixtures.

| tenant | state | the row that must move |
|---|---|---|
| inmersionfreediving | MX, 11 open, 10 clusters | "New Spanish article: apnea as a sport" — currently **7**, below hygiene at **23** |
| alaguillotine | US, 16 open, 24 clusters | 'alex karp height' at rank 29 — currently **1**, below a page that does not exist at **38** |
| superincompetence | US, 3 open, 186 queries | discovery work must read as hypothesis, not as reachable demand |
| casamigo | US, 15 open, 279 queries | control: a healthy board must not regress |

---

## Progress, as implemented

Every phase below is implemented, verified against the boards, and open as a stacked PR.
The stack must merge in order: **#244 → #248 → #249 → #250 → #251 → #252 → #255 → #256**
(#246 is independent of #244). The ordering is not about conflicts: #251 re-scores every
row from its stored inputs, so on `main` without #248 it would replay the provenance
defect — recomputing the apnea article 22 → 7.

| step | issue | PR | verified on a board |
|---|---|---|---|
| P0-1 freeze trap | #235 | #244 | new test fails if a frozen table has a live writer |
| P0-2 dead modules | #236 | #245 | suite 1939 → 1901; two kept, with reasons |
| P1-1 band guard | #241 | #246 | inmersion: schema 23 → 6, apnea stays 7 |
| P1-2 provenance | #240 | #248 | apnea 7 → 22; 1,577 rows backfilled |
| P1-3 hygiene gate | #238 | #249 | 0 detected rows move: both gated rows are `in_progress` |
| P2-1 one comparator | #242 | #250 | five boards identical order before and after |
| P2-2 re-score | #243 | #251 | 23 changed, then **0** on a second run |
| D1 evidence class | #237 | #252 | alaguillotine: rank-29 page **first** |
| T1/T2/T4/T5 (#232) | #232 | #255 | alaguillotine refused a market at 35% coverage |
| D3 candidate lane | #239 | #256 | four cases verified; live rows `unrecorded` by design |

### What measuring the boards changed about the plan

**The freeze trap was one entry, not ten.** `FROZEN_FUNNEL_MODELS` is the audit list; the
actual freeze was `FROZEN_CREATES` holding `researchAction`, which nine modules write. Two
existing tests asserted the bug.

**P1-3 moves nothing today.** The gate is preventive: both gated rows are `in_progress`.
Testing it live also bypassed the topic-map ownership guard and created 33 legacy rows on
a board the topic map owns — restored with `retireLegacyOpportunitiesForTopicMap`.

**D1 needed a stored column.** Prisma cannot order by a JSON field, so `assessment.kind`
could not be a sort key. `Opportunity.evidenceClass` is written wherever `scoreValue` is.
The migration also found 19 rows scored by a model that no longer exists — the band guard
changed what a score means without bumping `ASSESSMENT_VERSION`.

**The market floor needed coverage, not just share.** Alaguillotine clears a 25% share
floor (35% of 136 impressions) and would have bought US SERPs off a 31-country audience.
A share floor cannot separate it from susimacdonald; coverage can.

### Three defects found and deliberately not fixed

Each is filed with its measurement rather than half-fixed:

- **#253** — the AEO generator wraps any subject in a price template, so alaguillotine buys
  "How much does hemedti cost?" (Hemedti is a Sudanese military leader). The fix is a
  judgement about what a query is about; a person-name regex is banned and would fail on
  "adnoc owner".
- **#254** — 1–9 observed impressions are classed `hypothesis`. Relabelling them `measured`
  fixed casamigo and regressed alaguillotine and inmersion; the class and the scorer must
  change together.
- **#254** — `windowDays: 0` made real reach unsizable, and assuming 30 days scored a
  12-impression row at 1 and put it first on casamigo. The missing fact belongs upstream.

---

## Phase 0 — Safety. No behaviour change. Nothing reorders.

### P0-1 · The freeze trap (#235)

Remove `researchRun` from `FROZEN_FUNNEL_MODELS`. It is written by 8 live modules;
enabling `CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict` as the comment instructs would make
every bundle, map and proposal run fail its writes.

**Why first:** it is a documented instruction that breaks production, and it costs
one line to make safe.

**Verify:** a test asserts no model in `FROZEN_FUNNEL_MODELS` has a live writer, so
the next model to come back from the dead fails CI.

### P0-2 · Delete the 27 modules with no caller (#236)

Every one measured at zero callers in `lib/`, `app/`, `scripts/`, `components/`.
Most are covered only by their own test, so the suite shrinks. That is the point.

**Verify:** `tsc` clean, suite green with a *lower* count, and the deleted list
recorded in the PR so the drop is explained rather than mysterious.

---

## Phase 1 — Correctness. Wrong rows leave; nothing reorders yet.

### P1-1 · A technical row cannot take the readiness band

The band pays any `actionable`+`unquantified` row up to 76% of a ceiling of 30 and
ignores `severity`. Same defect scores 23 with unquantified demand and 6 with
measured demand. Severity 0.05 and 0.95 both give 23.

**Change:** guard the band so `technical` rows fall through to the technical branch,
which already computes `4 + 6·severity + 4·reach` correctly.

**Verify:** the same defect scores the same whether its demand is quantified, and
`severity: 0.3` vs `0.9` now differ.

### P1-2 · D4 — write `businessValueSource` (#240)

`proposalScoreInputs` sets `businessValue` from `cluster.relevance` and never records
the source, so `relevance` collapses to 0.25 on 1,654 of 1,965 rows. Apnea is 7 as
stored and 22 with the source populated.

**Change:** carry the provenance from the cluster's relevance judgement; backfill the
1,654 rows; and make "unknown" a distinct state from "known-low" so an unknown stops
being punished as a negative.

**Verify:** apnea's score does not change when the source is added, because it is
already there.

### P1-3 · D2 — a defect earns a board slot only when its page carries demand (#238)

**Change:** gate technical rows to (a) the affected page has measured impressions, or
(b) the page belongs to a cluster being drafted. Everything else moves to a health
list.

**Blocker to solve first:** no health surface exists. `lib/crawler/health.ts` computes
a score but nothing renders the defect list outside the board. **Ship the destination
with the gate**, or the information disappears.

**Verify:** inmersion's schema row leaves the top four, and its count is visible on
the surface the gate sends it to.

---

## Phase 2 — Ordering. This is the change that reorders boards.

Do not split these. A board reordered by half of D5 is wrong in a new way.

### P2-1 · D5b — one ordering function, four call sites (#237)

`scoreValue: "desc"` is written in four places that can disagree: the board,
the run report's top 5, the SERP watch list, and `applyOpenCap`'s overflow. Change
the scorer and the board reorders while the cap keeps parking the old rows.

**Change:** export one comparator and make all four call it. Test them together, so a
future fifth surface has an obvious function to use.

**Verify:** the board, the top-5, the watch list and the parked overflow agree on
which rows are "best" for the same project.

### P2-2 · D5c — recompute when the inputs change (#237)

`scoreValue` is computed once in `writeOpportunity` and never again; `lastScoredAt` is
written and unused. So a row keeps the score it had when first written, and a later
bundle that supplies impressions does not move it.

**Change:** a named re-score entry point, and the trigger decided explicitly.

**Open decision, needs an answer before code:** every bundle, every evidence write, a
nightly job, or on-read. Recommendation: re-score at the end of the pipeline's
opportunities stage plus a nightly sweep — cheap (1,965 rows) and current by the time
a person reads it.

**Verify:** after a bundle adds impressions to a query, the row's stored score moves
without re-drafting the proposal.

### P2-3 · D5a — one writer, and the backfill (#237)

`proposalPriority` becomes the source. Paths 3 and 4 are already deleted by P0-2.
Backfill every row and accept the reorder.

**Verify:** stored `scoreValue` equals `proposalPriority` for every open row.

### P2-4 · D1 — evidence class orders, score orders within (#237)

`assessment.kind` and `evidenceCompleteness` already exist and already multiply; they
must gate. Order: `measured → estimated → hypothesis`, and the class is printed beside
the number.

**Verify against the four boards in the table above.** This is the step where
alaguillotine's rank-29 page must outrank the page that does not exist, and inmersion's
apnea article must not sit below a schema count.

### P2-5 · D3 — a discovery proposal is a candidate until one SERP is bought (#239)

`expectedClicks: null`, labelled, with the cost to resolve it. The tranche's top N get
one $0.004 SERP and become `estimated` with measured competitiveness.

**Depends on:** the tranche (#232 T4/T5) for the N.

---

## What is deliberately not in this plan

- **The monthly tranche (#232 T4/T5).** Real, but a separate axis: it decides how much
  work a month holds, not how the work is ordered. Do it after Phase 2.
- **SERP attribution and the 2,645 orphan memberships (#232).** Data repair, no
  ordering impact.
- **A site-maturity flag.** Rejected in the architecture document §9. alaguillotine is
  new and casamigo is not, and they share the defect.

## Definition of done for the whole plan

1. Every open row's stored score equals what one named function computes from that
   row's inputs.
2. All four ordering surfaces call that function.
3. A row's class is visible beside its number.
4. The four boards pass the row-level checks in the table above.
5. The suite covers the failure that caused each step, not only the fix.
