# Structural recommendation review — 2026-11-04

## Implementation assignment

This review is now the failure baseline for the proposed corrective plan:
**“Finish the SEO analysis, not just the recommendation plumbing”**
(OpenChamber plan `fa6182c7-acf2-4c24-8ce4-054e6b3a0a50`).

Plan file:
`/home/admin/.config/openchamber/projects/path_L1NFTw/plans/1793822430905-finish-the-seo-analysis-not-just-the-recommendation-plumbing.md`.

**Goal for the implementation AI:** finish machine-resolvable relevance analysis
through shared, bounded evidence retrieval before returning customer work. Do not
merely rephrase historical findings or commission an audit of a page the system
could have read itself. Preserve genuine owner/expert questions and honest no-action
outcomes. Success requires fresh monthly discovery and same-evidence usefulness
review, not just valid JSON or green plumbing tests.

The plan defines seven ordered packages, exact service/result contracts, files to
change, retirement requirements, failing regressions and package exit checks.
After approval, begin with the contract/failure checkpoint, then implement the
evidence loop; continue through the dependent packages. Do not start another
unbounded redesign or stop at a partial contract migration. Production execution
and paid evaluation remain separately authorised.

The original review below is preserved as evidence; its findings must be mapped to
actual passing acceptance checks, not deleted or relabelled complete.

Reviewed HEAD: `01549cc`. Review only: no application logic changes, database writes, live fetches or model/provider calls. Evidence: current source, approved plan, saved `structural-*.json` evaluation artifacts, and three new offline probes.

## Verdict

**Do not accept the structural implementation as complete or the real-quality gate as passed.** The implementation contains useful contract/persistence work, but it is still a bounded one-shot adjudicator of findings, with weak predetermined retrieval. It does not resolve its own missing-evidence questions. The previous completion and “code never rewrites semantics” assurances are not supported by the checkout.

Reusing old findings is useful for regressions and is within the plan's initial O13/O14 boundary. It does not demonstrate fresh monthly opportunity discovery. O1–O12 remain legacy by the plan's explicit scope; that is not itself a defect, but it limits any whole-product claim.

## Product-critical findings

### 1. The assessor cannot investigate; analysis work is returned to the customer

`lib/recommendation/assess.ts:84-135` receives a fixed packet and returns one decision. Its only loop is schema/integrity correction. There is no bounded request for another page, fuller passage, source or journey inspection before the final recommendation. `run.ts:82-117` builds the packet once. A structured investigation is terminal output, not an instruction the analysis service executes.

This does not mean all investigations are bad: owner pricing policy and qualified legal review can genuinely require human input. Reading available public content is different. The system should complete that analysis before asking a customer to commission an audit.

Saved Susi result asks someone to read the land-investment page and American-buyer guide. Saved Atelier result asks someone to read `/lampes/abat-jours`, home navigation and `/devis`. Those are largely the relevance/coverage work the automated analysis was meant to perform.

### 2. Retrieval itself creates important evidence gaps

`lib/recommendation/packet.ts:63-67,327-359` chooses four pages using substring overlap, forces the homepage to the front, then allows three successful live fetches. The model prompt limits assessment to three pages (`assess.ts:47`). It cannot revise page selection.

In `/tmp/opencode/structural-susi.json`, the homepage and two other articles have text; the more relevant land-investment article is the fourth page and has zero characters. The saved final decision explicitly stalls on that unread page. The fixed allocation can prevent a fetch even when the page might be retrievable; this is not evidence of a genuine external blocker.

Live retrieval is plain `fetch` plus HTML stripping, not the existing rendered retrieval layer. It truncates to 8,000 characters before selecting sections. Section offsets are computed on whitespace-normalised text but applied to the original text (`packet.ts:171,197`). Live text is labelled `stored` by `buildPage` (`packet.ts:225`) and can retain a null/old stored content hash.

Inventory handling is also inconsistent: the loop fetches batches of 500 while declaring a cap of 200; ranking may use those 500 but the supplied inventory is sliced to 200 (`packet.ts:304-315,426`). None of this establishes the complete attributable retrieval required by package 2.

### 3. Semantic rules and semantic rewriting remain in code

`contracts.ts:504-509` categorically forbids a new asset if any assessed page partially answers, even when the AI could justify a distinct intent. This is stricter than the plan, which explicitly permits an evidenced distinct intent. `contracts.ts:436-438` treats supplied nontruncated text as enough to disallow “unassessable”, even though that text could be a challenge or shell.

`normaliseModelDecision` maps ambiguous meanings: readiness `partial` becomes `needs_investigation`; coverage `mixed` becomes `partially_answers`; unknown/missing target roles become `update` or `link_to` (`contracts.ts:534-667`). `finaliseDecision` silently removes conflicting coverage rows and prefers positive-answer rows (`contracts.ts:688-703`). These are semantic changes, not lossless decoding.

Offline probes reproduced both transformations. They contradict the pinned requirement to return validation errors instead of rewriting meaning.

### 4. A claim of no answer on an unread page can still pass validation

Using the saved Oceanic packet, the offline probe targets its zero-text course page, declares `does_not_answer` without excerpts, and returns an actionable update. `validateDecision` accepts it with `ok: true` and no errors.

This is a validator counterexample, not a claim that the saved model produced that update. It directly disproves the earlier blanket assurance that missing text cannot produce a false actionable recommendation. Coverage availability is not enforced for negative claims.

### 5. The old lexical decision-maker is still active on the shared refresh path

`lib/funnel/backfill.ts:328-329` still calls `reassessLegacyFindings`. That function uses absence/irrelevance regexes and lexical/page-type coverage, and can mark `coverageComplete` with no page text (`lib/research/reassess-findings.ts:20-21,125,140-155`). O13/O14 detection then skips unassessed rows carrying `verification === "contradicted"` (`lib/funnel/detectors.ts:471`).

Removing the synthesizer's drop is real progress, but it did not remove every competing verdict path. Legacy items can still disappear before canonical assessment on refresh.

### 6. Freshness/replay claims exceed the implementation

`run.ts:60-61` compares the saved decision's prompt version with its own saved dimensions, not the current prompt constant; it does not compare the configured current model. The packet policy hash does not fix model/prompt invalidation. Old judgements can survive a model/prompt change.

`reassess.ts:172-184` consumes its six-item budget before learning whether an item is reusable. With no ordering/cursor and a stable first six rows, later rows can remain skipped indefinitely. New-finding and existing-finding budgets are separate; failures can also be retried by the second pass.

The production evidence dimensions save the decision and packet hash but not the packet text or a durable packet artifact reference (`run.ts:188-209`). The exact model input cannot be reconstructed reliably after live pages change. Saved evaluation files are not production packet persistence.

### 7. Lossless presentation and safe task acceptance are incomplete

`views.ts:258-278` reduces presentation to the first coverage and benefit. It omits the structured investigation, coverage excerpts/rationale, premise and much of the risk/contradiction context from the summary component. References such as `source:<id>` and `fact:services` are passed to `SourceLink` as though they were URLs (`decision-summary.tsx:57-65,168-171,187-190`). Storing full JSON does not make the rendered recommendation lossless or intelligible.

`join.ts:213-251` trusts an optional caller-supplied decision, reloads only opportunity ID/status, and creates the task and accepts the opportunity in separate writes. It has no decision-version precondition or transaction. Omitted/null decisions retain the legacy acceptance path. It refuses all canonical investigations rather than providing the plan's distinct bounded-investigation task path. The prior claim of complete acceptance safety is not established.

### 8. Rejection reconciliation can miss the legacy opportunity it intends to retire

`run.ts:220-232` supersedes the old evidence then publishes using the new evidence ID. `publish.ts:118-120,147-149` looks for legacy opportunity edges from that new evidence ID. Existing edges ordinarily originate at the old evidence ID. A matching dedup key may rescue some cases, but changed legacy keys can leave old work visible. The simple rejection test does not prove this supersession case.

## Evaluation and completion claims

The saved final artifacts show one actionable update (Oceanic), three investigations and two rejections. That distribution is not intrinsically wrong; no quota of positive recommendations is appropriate. The problem is what it proves:

- The evaluation CLI selects existing findings by supplied substrings (`scripts/evaluate-need-assessment.ts:75-92`). It tests reassessment, not complete monthly discovery.
- The unseen tenant's pricing question is supplied through `--need` (`:156-166`), not discovered by the system.
- Missing-knowledge evaluation has its own fetching/assembly and sets all extracted fact source URLs to the first page (`:117-139`). It reuses the extraction model core but is not proof of identical production bootstrap input/provenance.
- There is no recorded independent specialist assessment on the exact saved packet. Schema validity is not an expert verdict on whether Oceanic's safety wording and chosen article are appropriate.
- The “shadow” code only builds packets and reports hash freshness (`reassess.ts:132-158`). It does not generate an unpublished proposed decision set or compare added/changed/removed/rejected work. Unchanged rows after this path prove no writes, not shadow-decision parity.

The existing passing suite therefore does not establish the business objective. Several deleted tests were replaced by narrower contract tests, and the handoff mapping cites tests that do not exercise the claimed full scenario. In particular, an English Oceanic output does not prove the Spanish high-risk acceptance case.

## What to retain

The schema/envelope foundation, exact-quote checks, explicit inferred versus observed needs, persisted decision fields, immutable decision history, task brief fields and shared assessor entry point are useful. The work was not for nothing. It is incomplete infrastructure, not demonstrated completion of useful autonomous analysis.

## Correct next acceptance target

Do not start another scoring/prompt-tuning pass or broaden into a new pipeline. Complete the current evidence/decision boundary:

1. Make available content actually readable through shared retrieval, with accurate provenance and a bounded way to resolve material evidence gaps before final judgement. Keep real owner/expert questions separate from machine-resolvable reading failures.
2. Remove remaining semantic overrides; reject ambiguous/conflicting model output rather than coercing it. Repair the concrete freshness, lifecycle and acceptance defects above.
3. Test fresh end-to-end monthly analysis as well as old-finding regressions. Have a qualified reviewer independently judge the same exact evidence, including whether investigations are necessary and whether proposed changes are genuinely useful. Do not supply a manually chosen need and call that discovery.
4. Only then reconcile package checkboxes, handoff claims and rollout readiness. The current implementation should not be deployed on the strength of the previous completion reports.

## Reproduction artifacts

- `/tmp/opencode/structural-review-probes.ts`
- `/tmp/opencode/structural-review-probes.json`
- Command: `npx tsx /tmp/opencode/structural-review-probes.ts`

No full test suite was rerun for this review; the historical 970-pass total is not new verification. No production logic was changed.
