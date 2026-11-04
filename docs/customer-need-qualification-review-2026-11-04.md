# Customer-need qualification: implementation and SEO review

## Verdict

**Changes required. Do not approve this implementation as universally reliable or
expert-quality yet.** Reviewed baseline: `a6dd576`, clean checkout before review.

The reviewed production path has no tenant-domain switch or domain-specific repair.
That is necessary but not sufficient: it still contains generic rules that lose
evidence, promote investigations to work, suppress legitimate opportunities and
retain outdated decisions. Earlier claims that the qualification defect was closed
were too strong.

This review does not change production data, run paid providers, deploy, or rewrite
the implementation. It inspects the code and the previously saved real model runs,
and exercises synthetic counterexamples against the actual functions. Synthetic
probes establish code behaviour, not model reasoning quality.

## High-priority findings

### 1. The assessed intervention is discarded; investigations can become implementation work

References: `lib/funnel/assess-need.ts:114-128`,
`lib/funnel/decision.ts:275-303`, `lib/research/need-assessment.ts:336-365`.

The assessment returns `intervention`, but the adapter never passes it to the
decision function. The decision instead infers an update from any gap, target and
nonempty `change`. It does not distinguish a specific implementation change from
an investigation question.

Reproduced: the assessor says `investigate`, with change **“Confirm which documents
the warranty team actually requires.”** The decision becomes **actionable /
update_page** and passes `assertDecision`.

Also reproduced: the assessor downgrades an unsupported new-asset proposal to
`investigate`; with empty coverage and `coverageComplete: true`, the adapter promotes
it back to **actionable / create_asset**.

Fix acceptance: persist and respect the assessed intervention; an unresolved
question cannot become an implementation instruction merely because it is text.
Support `improve_journey`, `maintain` and justified creation rather than inferring
every intervention from page-list shape.

### 2. Citation validation checks membership, not what each citation establishes

References: `lib/research/need-assessment.ts:235-281, 313-333, 596-658`.

Need, business fit and premise verification share one union of allowed URLs. A page
URL can validate invented customer demand; a forum URL can validate a claim that an
existing site answer contradicts a gap. Need and fit require no cited source excerpt
or fact identifier. A contradicted premise requires no matching page excerpt in the
validator, despite the prompt requiring one. `does_not_answer` also needs no excerpt.

Reproduced:

- No research sources supplied; the model cites the warranty page as proof that a
  customer asked. Need remains **supported**, and the output is actionable.
- A supposedly contradicted missing-answer premise cites only a forum URL and has
  no page coverage. It still causes **rejected**.
- A page change targets a blocked page while the only assessed inadequacy is on a
  different page. It is still actionable.

Persisted assessments also keep supported states with missing reference arrays;
normalising absent fields does not constitute evidence validation.

Fix acceptance: validate proposition-specific references, their actual content and
the target-to-coverage relationship. Keep an explicit distinction between observed
customer evidence and an inferred useful question. Neither allow-list membership
nor a model verdict proves the proposition.

### 3. Safety, uncertainty and benefit disappear before the recommendation is saved

References: `lib/funnel/detectors.ts:119-129, 1025-1046, 1095-1116`,
`lib/funnel/join.ts:155-182`, `lib/funnel/views.ts:222-247`.

The assessment contains review requirements, uncertainty and expected benefit. The
adapter preserves them temporarily, but the detector does not write those fields
into the recommendation's `scoreInputs`. It keeps only a one-line coverage summary,
not the checked coverage rationale and excerpts. Views attempt to read
`worth.uncertainty`, a field the producer never writes. The task brief also omits
review requirements and uncertainty.

Reproduced through `runDetectors` using an otherwise actionable assessment marked
`review: medical`: its candidate contains **no review requirement, no uncertainty
and no expected benefit**. These remain in the underlying evidence JSON, but do not
travel with the operative recommendation/task brief.

Fix acceptance: round-trip the complete assessed decision through evidence,
opportunity, views and task plan, with medical/legal review still mandatory.

### 4. Retrieval is sampled and truncated but can still claim complete coverage

References: `lib/research/need-assessment.ts:96-98, 393-419, 527-591`,
`lib/research/page-coverage.ts:39-45, 65-80`.

The loader excludes pages without `contentText`, reads at most 400 rows, picks
roughly six lexical matches and supplies only the first 2,600 characters of each.
It marks coverage complete using crawl page-count and HTTP status, not extraction
success or the fraction of relevant content actually assessed. Non-Latin retrieval
terms are discarded by the existing ASCII tokeniser. Audience and market options
exist, but the bridge does not supply them.

Reproduced: a completed, uncapped crawl whose pages have no extracted content yields
**zero assessment pages and `coverageComplete: true`**. Separately, the validator
accepts a quote at character 4,400 although the model payload ends at character
2,600. It validates the original full input rather than the actual supplied slice.

The real Susi assessment explicitly says the supplied text cuts off before the two
ownership options. It cannot establish what the rest of that page does or does not
explain. The Atelier runs inconsistently classify near-empty Wix HTML as
`does_not_answer` versus `unassessable`.

Fix acceptance: record fetch/extraction/truncation/assessment scope; examine relevant
sections rather than page prefixes; missing or unreadable content cannot support
absence. Use the same evidence preparation in evaluation and production.

### 5. Lexical judgements still reject findings before semantic assessment

References: `lib/research/runner.ts:575-600`,
`lib/research/site-claims.ts:100-142`,
`lib/research/synthesizer.ts:288-303`.

The runner still feeds lexical `assessCoverage` results into `verifySiteClaim`.
That function treats even `partially_answers` as contradicting a missing-answer
claim; the synthesizer then removes the finding before the new assessor sees it.

Reproduced: “The warranty page does not explain required claim documents” is marked
**contradicted** from a lexical partial match with two shared terms and no excerpt.
That is not verification of the exact question.

Fix acceptance: lexical matching is retrieval only throughout the producer path,
not only inside the new module. Existence of a related answer does not disprove a
specific missing detail.

### 6. Reassessment is neither freshness-aware nor reliably reflected on existing boards

References: `lib/research/finding-evidence.ts:209-227`,
`lib/research/runner.ts:530-540, 637-654`,
`lib/funnel/detectors.ts:1013, 1085, 1213-1215, 1284-1299`,
`lib/funnel/join.ts:185-212`.

An unchanged finding statement reuses its assessment regardless of page changes,
knowledge revisions, source changes, model/prompt version or age. The research
runner bridges findings inside the new-findings branch, not as a general legacy
reassessment pass. A later monthly run does not thereby upgrade all old rows.

Reproduced: an assessment dated 2020 under an obsolete prompt is reused without
loading current business facts or calling the assessor.

When all O13/O14 candidates are rejected or no-action, the detector may not record
that type in `produced`. Stale retirement then never checks it. Reproduced: a
previously detected false-premise recommendation remains untouched when its only
current finding is contradicted. Task acceptance still checks workflow status, not
canonical readiness, so historical rows are not protected by this new gate.

Fix acceptance: assessment reuse must be keyed to its evidence and policy versions;
rejected/no-action outcomes must update visibility coherently while preserving
accepted work and audit history. Test the transition from a formerly valid board,
not just creation of new rows.

## Universality and hardcoded assumptions

**No tenant-domain condition was found in the reviewed production path.** Domain
names in examples and comments are not runtime exceptions. The evaluation CLI takes
a domain argument; that is normal selection, not tenant-specific business logic.

However, “nothing hardcoded” would be an inaccurate assurance:

- `assess-need.ts:126` assigns every customer intervention `effort: small`.
- `detectors.ts:107-110` still derives a numeric business-value input from the
  presence of any knowledge record (0.9 versus 0.5). It no longer directly controls
  readiness, but it is still not a measured fit assessment.
- `need-assessment.ts:186-195` relies on a short multilingual risk vocabulary,
  including `fideicomiso`. That is a topic-specific safeguard, not a domain patch,
  but not a universal safety classifier. A Spanish underwater loss-of-consciousness
  instruction returns minimum review **none** in the probe.
- Fixed page/source/character limits are legitimate resource policies only when
  their effects on uncertainty and coverage are disclosed. Here they can affect
  conclusions without being represented in the contract.
- The six-assessment limit counts successes, not attempts. With
  `maxAssessments: 1`, four failing findings caused four attempted assessments.
  Failures are returned by the bridge but ignored by the runner's completion path.

No new numerical tuning or tenant exceptions are the remedy for these problems.

## SEO judgement on the actual saved outputs

### What is valid

- **Susi:** rejecting the blanket absence claim is justified by the existing
  foreign-ownership content. That is a valid correction, not proof of a newly
  insightful recommendation.
- **Atelier:** parliamentary-seat sources belong in pipeline diagnostics, not
  customer work. The rejection is appropriate.
- **Atelier's unreadable service page:** do not assert a gap. Correct restraint,
  but the system needs to retrieve the actual page before making a service-content
  judgement; asking the owner to confirm something already published is not an
  adequate automated substitute.
- **Casamigo:** a national portal result alone does not justify expanding a
  Riviera Maya business into Mexico City. Declining that work is sensible.

### What is not yet world-class

The saved real runs show **rejection/backlog**, not a validated positive example of
a supported, concrete improvement. The unseen tenant has extraction output and no
finding assessment; it does not demonstrate the complete qualification path.

The Susi assessor asks for consultation notes to establish that buyers ask about
ownership. With the same data, an expert would distinguish a plausible/inferred
buyer question from observed repetition, not require private CRM data before even
investigating a useful low-risk improvement. The prompt's instruction to avoid all
discussion of keywords, traffic and rankings removes the very search-intent context
needed to judge organic opportunities. Volume must not gate customer work, but
search evidence should not be excluded from SEO judgement.

Existing answers do not automatically eliminate linking, journey or discoverability
work. The decision's blanket adequate-answer branch returns no-action even if the
assessment identifies a separate verified journey problem. Conversely, adding any
page target automatically adds an organic-growth track without evidence of an
organic mechanism. These are not expert distinctions.

The real outputs also propose unsupported process requirements (for example a
minimum of five new sources in Atelier's rejected diagnostic). The validator checks
neither the proportionality of the requested work nor whether those evidence
channels are actually connected. Success criteria must not become arbitrary quotas.

## Why the previous proof was insufficient

`scripts/evaluate-need-assessment.ts:99-117, 193-220, 243-313` uses a different
retrieval/ranking path and live HTTP fetching, bypassing the production bridge's
stored-content loader, lexical pre-gate, clustering, persistence and lifecycle.
Its report retains only page prefixes and shortened source excerpts, not the exact
complete model input. The live verdicts cannot establish that the monthly system
produces the same outputs with the same evidence.

The deterministic tenant fixture builder supplies pre-written supported verdicts
with empty evidence references (`tests/customer-recommendations.e2e.test.ts:23-57`).
Those tests are now correctly labelled as wiring tests, but do not verify the
claimed evidence standard.

## Verification performed in this review

- TypeScript: `npx tsc --noEmit` passed.
- Seven focused suites: **71 tests passed**. Their green status did not detect the
  defects above.
- Thirteen adversarial behaviour probes confirmed the failures. They exercise
  actual parser, adapter, detector and bridge functions against synthetic data;
  they are not live SEO-quality tests and do not call a model or database.
- Existing real JSON outputs for Susi, Atelier, Casamigo and unseen extraction
  were inspected. No new paid evaluation or production write was performed.

Session-local reproduction artifacts:

- `/tmp/opencode/review-qualification.ts`
- `/tmp/opencode/qualification-review-probes.json`
- Run: `npx tsx /tmp/opencode/review-qualification.ts` from `/SEO`.

## Next bounded repair

First fix **intervention fidelity plus proposition/target validation** (findings
1–2). Lock the demonstrated counterexamples into tests and prove that an
investigation never becomes implementation work and that invalid evidence cannot
produce either actionable or rejected decisions. Then repair persistence and
production-equivalent retrieval before another quality sign-off. Do not retune
scores, manufacture positive recommendations or deploy this version on the basis
of the earlier test totals.
