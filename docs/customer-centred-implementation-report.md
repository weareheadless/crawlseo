# Customer-centred recommendations — implementation report

Commit series implementing `Customer-centred SEO recommendations — coding AI execution brief`.
This report states what was built, what was verified, and what remains. It is not a
claim that the boards are now useful: the end-to-end acceptance in §7 has not been
run against production data, and no production write, merge or deployment was made.

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

- `computeScore` bands by readiness, not by whether a volume number exists: rejected
  0, backlog ≤10, investigation ≤15, actionable-with-unquantified-impact ≤30.
- Acquisition reserves a share of the budget for customer-need queries so incidental
  traffic cannot starve them; seeds come from the finding's primary query, never a
  display title; "no data" answers are cached with an expiry so the same phrase is
  not paid for twice.

Not done: joins still do not rebuild assessment inputs from newly arrived evidence
(brief §4). The join writes an edge and recomputes from old inputs.

## Work package 5 — decision surface

- O10 no longer prescribes consolidation; O11 no longer prescribes a refresh; O13 no
  longer requires keyword validation. The generic labels now describe a check or an
  answer rather than a fix.
- "Both legs" now reads "two evidence legs" with the hint that neither proves the
  other.
- The opportunity detail page shows readiness, measurement basis, benefit track,
  intervention and the estimated benefit, before the evidence.

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

## Work package 7 — proof

Verified in CI-style runs:

- `npx tsc --noEmit` — clean
- `npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'`
  — 968 passed, 12 skipped
- `npm run build` — compiled successfully

`tests/customer-recommendations.e2e.test.ts` runs all five tenants plus negative
controls through inventory → coverage → verification → decision, and asserts the
expected readiness and reason for each finding.

Not verified, and therefore not claimed:

- No end-to-end run against production data. Existing crawls have no stored
  `contentText`, so a production reassessment today would mark legacy findings
  `unverified` (needs investigation) rather than contradicted. They would leave the
  actionable set but would not be proven false until the next crawl stores text.
- No independent SEO review of the resulting board.
- No browser/accessibility check of the detail page.
- Joins do not rebuild assessment inputs (see above).
- No merge, deployment or paid evaluation.

## Next step

Run the shadow projection (read-only) to see the decision diff on stored evidence,
then a crawl to populate page text, then the general reassessment — each behind the
existing approval for production writes.
