# Evidence-analysis safety and replay — 2026-11-04

## Assignment

**“Make the evidence-analysis session safe, convergent and replayable.”** Repairs
review findings R1–R6 from `docs/recommendation-analysis-review-06b1772.md`. This is a
prerequisite patch for the corrective plan, not a completion claim for packages 1–5.

No live model/provider evaluation, acquisition, production migration, publication,
merge or deployment was performed.

## Baseline failures reproduced

Offline probes at `/tmp/opencode/review-06b1772.ts` (results
`/tmp/opencode/review-06b1772-probes.json`) recorded:

- redirect destination contacted before rejection;
- expanded replay: two assessments, four reasoning calls, two evidence rows;
- a valid investigation rejected at acceptance;
- a 387k packet stored as 200k invalid JSON;
- a truncated prefix accepted as a whole-page negative assessment;
- a source request reporting success without new evidence.

Those cases are now repository regressions in `tests/recommendation-safety.test.ts`
(desired assertions), plus the existing acceptance/shadow regressions.

## Implemented

### Safe bounded retrieval

`lib/crawler/engine.ts` exports `fetchPublicDocument`:

- manual redirects; every hop is shape-checked and DNS-resolved **before** dispatch;
- protocol, credential and non-standard-port rejection;
- streamed body with an explicit byte cap and truncation flag;
- injectable resolver for deterministic redirect tests.

`lib/recommendation/packet.ts` uses it instead of `fetch(..., redirect: "follow")`.
No forbidden hop is contacted. Builder-site markup stripping remains.

### One actual run budget

- The runner's shadowed `analysisLedger` was removed. New findings, reassessment and
  the resumed-bridge repair share the runner-owned ledger.
- `chatJson` now accepts `beforeAttempt`; the assessor charges every transport
  attempt before dispatch, including retries and repairs.
- Initial packet retrieval is deterministic stored evidence only (`maxLiveFetches: 0`);
  requested evidence pays from the same ledger.
- Fetch budget is charged per redirect hop before dispatch, including failed reads;
  bytes and elapsed time are tracked. A zero allowance means zero dispatches.
- No limits were raised in this patch.

### Request convergence

- Packets carry `requests[]` with terminal states: `fulfilled`, `partial`,
  `unavailable`, `no_progress`, `budget_exhausted`.
- A request already attempted and terminal is refused instead of replayed as new.
- `source_text` without authorised external retrieval is explicitly `unavailable`,
  not a fake success.
- Two consecutive no-progress rounds stop the analysis with a typed failure.
- Requested pages are supplied whole; failed/omitted pages remain visible limitations.

### Complete archive and replay

- `recommendationFinalPacketJson`, `recommendationInitialPacketHash`,
  `recommendationAttemptsJson` and `recommendationRequestsJson` are stored without
  string slicing. A >200k packet round-trips as parseable JSON.
- Reuse validates the decision against the archived final packet, the current
  model/prompt/policy versions, the stable initial-packet hash and a seven-day
  freshness window. An unchanged expanded candidate returns `reused` with no new
  reasoning call or decision revision.
- A failed reassessment records an operational failure in `RawProviderResponse`
  while preserving the previous valid decision.
- A resumed run with existing findings but missing bridge evidence repairs the
  bridge before reassessment.

### Scoped coverage

- Coverage may declare `scope: "section"` with inspected `sectionIds`.
- A truncated page cannot support a whole-page `does_not_answer` claim; the model
  must scope the finding to inspected sections or request the rest.
- Positive claims still require verbatim excerpts from supplied text.
- This is a scope/integrity rule, not a semantic classifier.

## Verification

```
npx tsc --noEmit                                   # clean
npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'
# 992 passed, 16 skipped
DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 npx vitest run \
  tests/customer-recommendations-postgres.integration.test.ts
# 4 passed
npm run build                                      # exit 0, compiled successfully
```

New regressions cover: redirect rejection before the second hop, body cap/truncation,
zero-fetch budget, transport-attempt charging, unchanged expanded replay, repeated
unavailable request termination, >200k packet persistence, failed-reassessment
preservation, and truncated-vs-section coverage scope.

## Still open

- R7 lifecycle/acceptance and R8 shadow/rollback remain release blockers; the normal
  acceptance action still needs the render-time version and canonical investigation
  flow.
- Independent SEO/business review, held-out fresh monthly discovery, full all-tenant
  shadow diff, browser/accessibility pass and production rollout remain pending.
- O1–O12 remain legacy and are not claimed as AI-qualified.

No approval is implied by green tests.
