# Customer-centred recommendations — implementation report

Commit series implementing `Customer-centred SEO recommendations — coding AI execution brief`.
This report states what was built, what was verified, and what remains. It is not a
claim that the boards are now useful: the end-to-end acceptance in §7 has not been
run against production data, and no production write, merge or deployment was made
in this boundary. Three additive migrations were applied to the application database
during earlier work in this series (`audit_page_content_text`,
`research_finding_verification`, `acquisition_receipt`); that history is recorded
here rather than hidden behind a blanket "no production write".

## Work package 1 — fixtures

`tests/fixtures/customer-recommendations.ts` holds sanitised reconstructions of the
review: Susi (foreign-ownership content exists), Atelier (off-topic parliamentary
sources; existing lampshade/quote/B2B pages; a 429), Casamigo (city pages exist; no
evidence for Mexico City), Oceanic (course choice, safety, existing answers), and an
unseen tenant with root-level pages and no GSC or volume data. Negative controls
cover a genuine gap, multiple URLs without harm, a rate-limited page, incidental
high-volume traffic and a strong need with unknown demand.

Fixtures carry page text, because a conclusion drawn without content is the failure
being fixed.

## Work package 2 — decision contract

`lib/funnel/decision.ts` separates five dimensions that the score conflated:

- evidence state: supported / unverified / contradicted
- readiness: actionable / needs_investigation / research_backlog / rejected
- benefit track: customer value / organic growth / technical health
- benefit measurement: observed baseline / forecast / unquantified
- intervention: update page / create asset / investigate / technical fix / maintain

Precedence is explicit: a contradicted premise is rejected before anything else, a
research-quality failure is rejected as business work, a verified technical problem
is actionable without demand, and a supported need with a verified change is
actionable even when the organic impact is unquantified.

`tests/funnel-decision.test.ts` (13 cases) exercises every branch, including "two
evidence legs cannot override a contradicted premise" and "missing volume cannot
demote a supported low-risk intervention".

## Work package 3 — content grounding

- `AuditPage.contentText` (additive migration) stores extracted page text; the
  crawler already computed it and threw it away.
- `lib/research/page-coverage.ts` assesses a need against page text, declaring its
  method as lexical, showing matched terms and excerpts, and returning
  `unassessable` for pages with no retrievable text rather than "does not answer".
- `verifySiteClaim` no longer treats an unmatched URL-derived page type as proof of
  absence. Absence needs complete coverage; a page-content match contradicts the
  claim regardless of its URL.
- Verification is persisted on `ResearchFinding` (additive migration) and carried
  into funnel evidence, so a contradicted premise cannot become an opportunity
  again at the bridge.
- The synthesizer receives a `verifyClaim` callback; the runner supplies one backed
  by every page of the latest crawl.

## Work package 4 — assessment, joins, acquisition

- `computeScore` keeps a compatibility index for existing consumers. Readiness is
  decided before it and does not depend on it; the index is not evidence and no
  constant was tuned to move a tenant's card.
- Acquisition reserves a share of the budget for customer-need queries so incidental
  traffic cannot starve them; seeds come from the finding's primary query, never a
  display title; "no data" answers are cached with an expiry so the same phrase is
  not paid for twice.

Joins rebuild demand inputs from a newly arrived measurement (`d3bf65a`) instead of
only adding an edge.

## Work package 5 — decision surface

- O10 no longer prescribes consolidation; O11 no longer prescribes a refresh; O13 no
  longer requires keyword validation. The generic labels now describe a check or an
  answer rather than a fix.
- "Both legs" now reads "two evidence legs" with the hint that neither proves the
  other.
- The opportunity detail page shows readiness, measurement basis, benefit track,
  intervention and the estimated benefit, before the evidence.
- Accepting a recommendation now creates the task with its brief: need, existing
  coverage, target page, the specific change and the success measure
  (`taskPlanFromOpportunity`). Before, the task carried only the title.
- The board list shows readiness and "impact not quantified" on every row, so
  actionable work, investigations and backlog are separable without opening each
  opportunity.

Not verified: no browser check on desktop/mobile was run in this pass.

## Work package 6 — reassessment and rollback

- `lib/research/reassess-findings.ts` re-verifies active findings that carry no
  verification, using the site's own inventory, stored page text and the finding
  text. It derives only two things mechanically — an absence sentence naming an
  existing page type, and a finding that says its sources were off-topic — because
  both only ever remove work. Evidence is superseded, never edited.
- It runs inside every evidence refresh, so a contradicted premise leaves the
  actionable board at the next run, and `retireStaleDetected` parks its opportunity.
- `scripts/shadow-analysis.ts` no longer rebuilds evidence by default: rebuilding
  changes what the next detection sees, which is an indirect write to the board.
  `--rebuild` opts in.
- `scripts/reanalyse-all.ts` snapshots the full published state (summary, score
  inputs, status, park reason, assessment version) with a checksum, restores all of
  it, refuses a snapshot whose checksum does not match, and refuses to overwrite a
  human decision made after the snapshot.

## Database integration (work packages 6 and 7)

`tests/customer-recommendations-postgres.integration.test.ts` runs against a
disposable schema (`csv_validation`), never the application schema:

```
DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 npx vitest run \
  tests/customer-recommendations-postgres.integration.test.ts
# 3 passed
```

It proves, on real rows:

- a legacy finding with no verification is re-verified on refresh;
- a premise contradicted by stored page text produces no customer-need opportunity;
- a supported need produces an `actionable` opportunity with `measurement:
  unquantified` and a non-zero score, with no keyword volume anywhere;
- a rollback restores the published state and refuses to overwrite a human decision
  made after the snapshot;
- a snapshot whose checksum does not match is refused.

### Read-only dry run on production data

`reassessLegacyFindings(..., { dryRun: true })` over the four live tenants:

| Site | legacy findings | contradicted | unverified |
|---|---:|---:|---:|
| susimacdonald.com | 22 | 0 | 22 |
| atelier-harmonie.com | 63 | 0 | 63 |
| casamigo.net | 2 | 0 | 2 |
| oceanicvibes.com | 5 | 0 | 5 |

Every finding is `unverified`, because the crawls that produced them stored no page
text. This is the honest result: without content, a legacy premise cannot be proven
false mechanically, and none of them can become actionable work — they leave the
actionable set and wait for a crawl that stores text.

Two earlier attempts at deriving claims from prose were rejected during this work
because they contradicted the wrong things: one matched a competitor's quoted
"Property for Sale" page, the other read "no Mexico City inventory" as "no city
pages". The rule is now deliberately narrow and still yields no contradictions on
legacy prose, which is why the dry run shows none.

## Customer-need qualification repair (later pass, 2026-11-04)

The earlier claim that work package 3 was complete was wrong. `assessCustomerNeed`
still treated the existence of a business-knowledge document as supported business
fit, invented a generic page update, and let a lexical coverage record plus that
change become actionable. This pass replaced that boundary.

- `lib/research/need-assessment.ts` asks the configured model to assess the finding's
  premise, the customer need, offer fit, per-page coverage, intervention and success
  measure from the extracted facts, the finding's sources and actual page text. Every
  URL must be one we supplied; every positive coverage claim must carry a verbatim
  excerpt from that page. Unsupported claims are downgraded to unknown.
- `lib/funnel/assess-need.ts` uses only that assessment to establish support. Without
  one, the finding stays in the research backlog: knowledge presence alone is not fit,
  and the adapter no longer invents a change or a benefit.
- `lib/funnel/decision.ts` adds `no_action`: an adequate answer is left alone even when
  a change is proposed. An unassessable page is an investigation, never a demonstrated
  gap. A supported need plus an evidenced inadequacy and a specific change remains
  actionable with no keyword volume.
- `lib/research/finding-evidence.ts` runs the assessment during the monthly research
  bridge, bounded per run, and persists it with the finding evidence. The detector
  carries the need rationale, offer-fit rationale, evidence URLs and model version into
  the recommendation record.
- `extractBusinessKnowledgeFromSite` now accepts the site it is extracting. It used to
  take the project's oldest site, so a preview mirror could supply the facts used to
  judge a production site. The monthly analysis passes the site it is analysing.

Deterministic regression: `tests/need-assessment.test.ts` (validation and review),
`tests/funnel-decision.test.ts` (no-action and unassessable branches), and the tenant
fixtures with explicit pre-made assessments. These prove wiring, not that the model
reasons well; the fixtures say so in their comments.

### Real assessment runs (read-only, no recommendations published)

`scripts/evaluate-need-assessment.ts` reads the tenant and its findings, retrieves
candidate pages from the crawl inventory over public HTTP, reuses the real extraction
core when knowledge is missing, and runs the real model assessment. It writes no
knowledge revision, opportunity, task or paid search call.

| Site | Finding | Result |
|---|---|---|
| susimacdonald.com | Foreign land ownership and fideicomiso | **rejected** — the supplied posts explain the fideicomiso and the restricted zone; the model cited both |
| atelier-harmonie.com | Corpus de sources hors sujet | **rejected** — pipeline-quality failure; the pages were retrieved but the sources are off-topic |
| atelier-harmonie.com | Abat-jour sur mesure sans page dédiée | **research backlog** — the dedicated page was retrieved, but its Wix HTML contains only boilerplate, so coverage is unassessable; no work was proposed |
| casamigo.net | Mexico City not covered by site inventory | **rejected** — offer fit contradicted: the extracted facts limit the service area to Riviera Maya markets |
| Astrid preview (unseen) | none | **automatic extraction** — 8 pages read, language `es`, 9 fields extracted, nothing written |

Susi evidence, verbatim from the assessment:

> "The finding says no candidate page addresses foreign ownership or restricted-zone
> land, but two supplied posts do. One is specifically about fideicomisos in Mexico's
> restricted zones, and the other explains that foreigners cannot own land within the
> restricted zone and says there are two options."

Honest limitations:

- The live fetch does not execute JavaScript. On Wix, the dedicated page's body text
  is client-rendered, so the assessment could not read it and did not claim absence.
  A crawl that stores rendered text, or a headless fetch, is still needed for that
  page.
- The assessment runs for findings bridged by the monthly research runner. Existing
  evidence rows have no assessment and remain backlog until re-bridged; no production
  board was refreshed.
- These are single real runs, not a statistically meaningful evaluation of model
  quality, and they have not had independent SEO review.

## Work package 7 — proof

Verified in CI-style runs:

- `npx tsc --noEmit` — clean
- `npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'`
  — 1002 passed, 16 skipped
- `npm run build` — compiled successfully
- `tests/customer-recommendations-postgres.integration.test.ts` — 4 passed on the
  disposable `csv_validation` schema, including the assessment-to-opportunity path.

`tests/customer-recommendations.e2e.test.ts` runs all five tenants plus negative
controls through inventory → coverage → verification → decision, and asserts the
expected readiness and reason for each finding.

Not verified, and therefore not claimed:

- No end-to-end run against production data. The read-only dry run above is the
  closest mechanical evidence; the real assessment runs above are the closest
  qualitative evidence. Legacy findings become `unverified` and leave the actionable
  set, but are not proven false until a crawl stores page text.
- No independent SEO review of the resulting board.
- No browser/accessibility check of the detail page. What was verified instead: the
  decision panel has a server-render test, the production build compiles, and the
  running app served the page over HTTP against seeded rows, rendering "Actionable",
  "Impact not quantified", "Customer value" and "intervention · update page". The
  in-app browser could not reach the local server, so layout and accessibility are
  unreviewed.
- Joins rebuild assessment inputs, but the full monthly worker rerun/idempotency and
  budget-failure acceptance in §7 has not been exercised.
- No merge, deployment or paid evaluation.

## Next step

Run the shadow projection (read-only) to see the decision diff on stored evidence,
then a crawl to populate page text, then the general reassessment — each behind the
existing approval for production writes.
