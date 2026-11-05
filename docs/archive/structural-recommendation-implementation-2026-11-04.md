> **Superseded by the corrective pass:** this report described the one-shot reviewer.
> The current implementation and verified results are in
> `docs/structural-recommendation-handoff-2026-11-04.md`.
>
> **Product scope:** read
> [`crawlseo-product-operating-model.md`](../crawlseo-product-operating-model.md).
> This report is engineering history, not product acceptance.

# Structural recommendation implementation — 2026-11-04

## What changed

The fragmented qualification path has been replaced by one canonical pipeline:

`evidence packet → AI decision → integrity validation → persisted decision → existing opportunity/task projection`

Production, reassessment and evaluation now share the same packet builder, model
assessor and validator. There is no separate evaluation ranking or qualification
algorithm.

### New modules

- `lib/recommendation/contracts.ts` — runtime schemas for the evidence packet, the
  model decision and the final decision; packet sealing/hashing; reference, target,
  coverage and consistency validation. Code validates integrity, roles, scope and
  internal consistency. It does not rewrite an intervention or invent a fallback.
- `lib/recommendation/packet.ts` — builds the finite packet from business knowledge,
  the latest crawl inventory, relevant page sections, research sources, search
  observations and explicit limitations. A bounded live fetch is used only when the
  crawl stored no text. Packet IDs use SHA-256, not a colliding base64 prefix.
- `lib/recommendation/assess.ts` — the single model prompt and bounded correction
  loop. The model chooses readiness, intervention, change/investigation, targets,
  benefits, effort, risks, reviews, success measure and uncertainty.
- `lib/recommendation/run.ts` — assesses one finding, reuses a decision only when the
  sealed packet hash matches, preserves a previous valid decision on model failure,
  and writes immutable evidence.
- `lib/recommendation/publish.ts` — projects the validated decision into the existing
  `Opportunity` row; rejected/no-action outcomes park the linked detected row,
  including legacy rows found through the evidence edge.
- `lib/recommendation/reassess.ts` — reassesses every active finding, not only new
  findings. Reuse is keyed to the packet hash and policy/prompt/model versions.
- `Opportunity.recommendationDecision`, `recommendationVersion`,
  `recommendationFingerprint`, `recommendationEvidenceId` (additive migration
  `20261104180000_opportunity_recommendation_decision`).

### Removed or bypassed competing rules

- Deleted `lib/funnel/assess-need.ts` and `lib/research/need-assessment.ts`.
- `lib/funnel/decision.ts` no longer contains `decideRecommendation` or
  `assertDecision`; it now supplies shared labels/types only.
- Detectors O13/O14 no longer infer readiness from coverage arrays, score inputs or
  knowledge presence. They project the validated decision. Legacy findings without
  a decision remain explicitly unassessed backlog.
- `synthesizeResearch` no longer drops a finding when the old lexical claim check
  flags its premise. The finding is kept with the diagnostic verification, and the
  canonical assessor decides.
- The evaluation script now wraps the production packet/assessor/validator in
  read-only mode. It has no independent retrieval or ranking path.

### Persistence and reader path

- The complete decision is stored with the research evidence and copied into
  `Opportunity.recommendationDecision`.
- Board/detail/API read the canonical decision; legacy score-input reconstruction is
  a fallback for rows without one.
- The detail panel shows existing coverage, exact change, target page, success
  measure, uncertainty, need/offer-fit rationale, evidence refs, model version and
  review requirements.
- Accepting work re-checks readiness: an investigation, backlog, rejected,
  no-action or malformed decision cannot become implementation work. The task plan
  stores the full canonical brief and decision version.
- Hysteresis and the open cap no longer hide a row that carries a canonical decision.

### Monthly/reassessment path

- The research bridge assesses new findings and then runs
  `reassessProjectRecommendations` for every active finding, even when the run
  created no new findings.
- Reassessment reuses a decision only when the packet hash, policy, prompt and model
  match. A changed page, source, fact, prompt or model invalidates it.
- Failed attempts count against the assessment ceiling. A failure is recorded as an
  operational quality event, not a customer rejection.

## Deterministic verification

- `tests/recommendation-contract.test.ts` — 10 integrity cases: investigation cannot
  become implementation; blocked target; wrong evidence role; unsubstantiated
  contradicted premise; empty-coverage asset; quote outside supplied text; packet
  hash changes with content; multiple review requirements; decision identity.
- `tests/research-finding-evidence.test.ts` — context findings, assessment/publish,
  packet-based reuse, failure without invention, attempt ceiling.
- `tests/customer-recommendations-postgres.integration.test.ts` — real disposable
  schema: legacy contradiction/backlog, assessment → persisted evidence →
  actionable opportunity, rollback, checksum refusal.
- `tests/funnel-task-gate.test.ts` — investigation cannot be accepted as
  implementation.
- Full suite: **970 passed, 16 skipped**; `tsc` clean; production build compiles;
  integration **4/4** on `csv_validation`.

These tests prove wiring and integrity, not live SEO judgement.

## Real read-only evaluation

Same production packet builder/assessor/validator, `persist: false`, no provider
spend, no opportunity/task/knowledge write.

| Site | Finding | Decision |
|---|---|---|
| Susi | Foreign land ownership / fideicomiso | **needs_investigation** — premise contradicted (the scam guide already names restricted zones and fideicomiso), but a more relevant land-investment page was unassessable; bounded check before deciding between expanding the partial answer and leaving it |
| Atelier | Corpus de sources hors sujet | **rejected** — the corpus is a research failure, not a customer question |
| Atelier | Abat-jour sur mesure sans page dédiée | **needs_investigation** — existing category page text is unavailable; bounded check before creating a duplicate |
| Casamigo | Mexico City not covered | **rejected** — Riviera Maya offer fit contradicted; one Realtor.com item is not customer demand |
| Oceanic | Beginner depth safety / lanyard | **actionable / update_page** — one observed beginner request; existing land-practice article partially answers it; add lanyard/depth-supervision section with subject-matter and legal review |
| Unseen Astrid site | Inferred balayage cost/inclusions | **needs_investigation** — automatic extraction supplied 9 business facts; pricing disclosure and the Spanish page content are unresolved |

Full packet, retrieved text, decision, validation result and raw model output are in
the JSON files written by `scripts/evaluate-need-assessment.ts` (for example
`/tmp/opencode/structural-susi.json`, `structural-oceanic.json`,
`structural-casamigo.json`, `structural-atelier-corpus.json`,
`structural-unseen.json`).

The Oceanic output demonstrates the intended positive case: an observed beginner
question, an existing article that partially answers it, and a specific update with
safety/legal review. Susi shows the restraint case: the false absence claim is
recorded, but an unassessable more-relevant page keeps the work at a bounded
investigation rather than a guess.

## Remaining work

- **Package 6** (shadow/rollback) is not implemented in this pass. Existing
  `scripts/reanalyse-all.ts` and snapshot/rollback remain the starting point and need
  the canonical decision/read-model version added.
- **Package 5** still needs accepted-work change warnings: a new decision can update
  an accepted opportunity row, but the task snapshot is preserved. The UI does not
  yet visibly flag that the premise changed.
- The live evaluation uses a bounded live-fetch fallback because production crawls
  have no stored `contentText`. The monthly path will use stored text once a crawl
  populates it; the fallback is explicit in packet limitations.
- Inventory is capped at 200 pages for the packet; a 500-page crawl is disclosed as
  incomplete. The assessment cannot prove absence beyond that scope.
- No independent SEO/business review of the outputs yet; these are single real runs,
  not a statistically meaningful model evaluation.
- No production migration, reassessment, board refresh, merge or deployment. The
  new migration was applied only to the disposable `csv_validation` schema.
- No browser/accessibility pass on the updated detail panel.
