# Recommendation analysis review — `06b1772`

## Verdict

**Real progress, not ready for acceptance or rollout.** Keep the evidence-request loop and the useful Susi result. Do not repeat the earlier conclusion that packages 1–5 are complete. The production orchestration, accounting, replay, archival fidelity, acceptance and rollback checks below are still failing or missing.

Reviewed checkout: `06b1772`, clean at review start. This review changes no production logic and makes no live network/model/provider calls or database writes. It uses source inspection, saved evaluation history and new offline probes with fake storage/injected reasoning.

Verified during review:

- `npx tsc --noEmit`: exit 0.
- Four focused test files: **45 passed**, exit 0.
- Six offline counterexamples: `/tmp/opencode/review-06b1772.ts`; results `/tmp/opencode/review-06b1772-probes.json`.
- No full-suite, build, database, browser or independent SEO verification was performed in this review. Previous counts are historical, not new review evidence.

## What is genuinely better

The AI can now request page evidence before final judgement. The recorded Susi run reads previously omitted foreign-ownership content and returns no-action rather than delegating the reading to a person. Strict enum handling, rejection of duplicate coverage and zero-text negative coverage are worthwhile improvements. These should be retained.

The new tests nevertheless overstate what they cover: the named request→retrieval→decision regression requests `source_text`; its implementation supplies no additional source text and the injected assessor returns a final answer anyway. It does not prove successful page retrieval, request convergence, real dispatch ceilings or changed-dependency replay.

## Blocking findings

### R1 — live retrieval is not safe at the redirect/body boundary

**Priority: high.** `lib/recommendation/packet.ts:202–262` checks the initial hostname, calls `fetch(..., redirect: "follow")`, and checks the final host only after the request has already followed redirects. The rejected destination may already have been contacted, including a private-network destination. Domain membership also does not validate protocol, credentials, ports or every redirect's resolved address. The crawler already has a manual-redirect, public-address and capped-body path; the recommendation fetcher does not reuse it.

`response.text()` reads the entire body before a text-length cap. Removing a premature HTML prefix cap was correct for builder sites; removing the network byte limit entirely was not. Retain full-document extraction within an explicit streamed byte limit and return a typed incomplete result when exceeded.

**Required proof:** mocked redirect chains reject a private/off-origin/unsupported destination before dispatching that hop; body-size and time limits stop reads. No real requests to private services during tests.

### R2 — the shared run budget is not actually shared or charged per attempt

**Priority: high.** The runner creates a ledger at `lib/research/runner.ts:543`, then shadows it with another `const analysisLedger` at line 644. New findings use the inner budget; existing-finding reassessment uses the untouched outer budget. The second lane can retry failed work with a fresh allowance.

`assess.ts:127–138` charges one model call but gives `chatJson` three transport attempts. Initial packet fetches are never charged to the ledger. Expansion charges `expanded.retrieved`, not attempts, so failed fetches and journey fetches escape accounting. `packet.ts:677` turns a zero remaining fetch allowance into one permitted fetch. `maxTokens` is per response, not an aggregate input/output or spend budget; the ledger has no elapsed-time/spend reservation enforcement. Candidate synthesis/extraction are outside this ledger as well.

The previous implementation also increased hardcoded limits while repeatedly rerunning live cases. Further increases are not an acceptable repair or implicit spend authorisation.

**Required proof:** one production-run ledger covers both lanes and actual dispatch/retry/fallback attempts, enforces zero literally, records failures, and stops before dispatch without bypasses. Use existing allowances/reservations; no new budget service.

### R3 — expanded decisions do not reuse on an unchanged replay

**Priority: high.** A decision references its final expanded packet. `run.ts:113–145` rebuilds the initial packet and compares that initial hash to the final hash. It does not recover/revalidate the saved final packet's dependency manifest or fetch cache. Requested pages and request-added limitations therefore make the hashes differ even when all evidence is unchanged.

The offline probe runs the same candidate twice, with one evidence request then one final decision each time: **both return `assessed`, four reasoning calls, two evidence records**. Expected: the second run reuses, with no extra reasoning or decision revision. The probe is injected reasoning, not a paid model claim.

`reassess.ts:172–185` additionally prepares a packet before its budget check, then `assessFinding` prepares it again. Oldest-first ordering is not a cursor: repeatedly failing/stale oldest rows can still consume every run's available slots and starve later rows. A resumed run with existing findings but no bridged evidence also has no generic bridge repair in the no-new-findings path.

**Required proof:** replay from final dependencies is stable; cached retrieval is reused subject to explicit age/version policy; later pending candidates progress after failures; retry/resume repairs interrupted bridging without duplicate work.

### R4 — request resolution can report progress without obtaining evidence

**Priority: high.** `packet.ts:740–749` accepts `source_text` but only adds a limitation saying the same excerpt is already supplied. It neither retrieves full source content nor reports a terminal failed/unavailable request. Offline probe: sources unchanged, `retrieved: 0`, `failed: 0`. Repeating it remains a valid request; there is no general completed-request/no-progress cache.

Requested truncated pages are refetched live even if complete stored body text is available. Pages longer than the 20k requested prefix cannot request a specific later section; repeating the same request re-downloads the same prefix. When the page list is full, the function may fetch a page, return it as retrieved, but omit it from the packet. Failure messages appended after 20 limitations may disappear through slicing. The new source/request loop test does not catch any of these cases.

**Required proof:** every request returns a typed fulfilled/partial/unavailable/budget-exhausted status tied to the request and exact supplied evidence. No-progress cannot be counted as success or loop forever. Available stored full text/sections precede live retrieval; deep sections can be inspected without raising token limits. Source retrieval uses authorised safe scope, or returns an explicit terminal limitation rather than pretending to fetch it.

### R5 — exact production packets can be stored as invalid JSON; attempt history is missing

**Priority: high.** `run.ts:274,334` stores `JSON.stringify(packet).slice(0, 200_000)`. The schema permits packets larger than this. Offline probe creates an allowed 500-page inventory: packet **387,130 characters**, stored **200,000 characters**, stored JSON **does not parse**, while the service reports `assessed`.

Raw attempts/corrections are not persisted. `raw` is overwritten on every loop iteration; `clippedRaw` is unused. A failed reassessment with previous evidence returns without storing the failed attempt. An invalid injected final decision also returns without a durable failure event. A hash and a summary ledger are not the promised immutable input/attempt archive.

**Required proof:** a protected, complete, hash-verifiable final artifact and ordered attempt/request results remain retrievable after live content changes. Oversized input uses a proper artifact reference or explicit safe rejection—not string slicing. Read-only mode writes only to its authorised isolated artifact destination.

### R6 — partial text can still justify an unscoped negative coverage claim

**Priority: high.** `contracts.ts:539–542` checks only that some text exists. An inspected/truncated prefix with no price can still become `does_not_answer` and an actionable page update even when an uninspected section contains the full answer. Offline probe: truncated body, 27 supplied characters out of 5,000, unqualified negative assessment; **validation accepts it**.

Do not fix this with another universal content-length or page-count gate. Distinguish section-scoped observations from full-page claims; the AI must inspect missing material sections or explicitly limit the proposition. A readable positive excerpt may establish a local answer; a partial prefix cannot establish whole-page absence.

The added investigation guard (`contracts.ts:569–575`) is also a new string classifier: mentioning a supplied URL in an owner-confirmation question is rejected, while the same question paraphrased without the URL bypasses it. Use typed unresolved requirements, not URL-substring semantics, to separate machine reading from owner/expert decisions.

### R7 — investigation acceptance and stale-page protection remain incomplete

**Priority: high.** `join.ts:256–259` rejects any supplied decision not marked actionable before reaching its supposedly supported investigation branch. The actual server action always supplies the stored decision. Offline probe: a schema-valid investigation passes `validateDecision` but acceptance throws `cannot be accepted into implementation work`.

`acceptOpportunityAction` accepts only site/opportunity IDs, reloads the decision after the click and passes that fresh decision to the gate. It does not receive the version actually shown to the user. The current stale-decision unit test calls the service directly and does not exercise this action. Missing expected versions are permitted by the service. The action checks site access but does not bind the supplied opportunity ID to that site's project; maintain explicit tenant scope in the repair. The related ownership pattern predates this pass, but the revised acceptance path still depends on it.

Task updates are transactional with a full Prisma client, but the service's optional transaction fallback is not atomic. Rejected/no-action publication skips accepted rows (`publish.ts:132`), so the current projection may never change and the promised changed-premise warning can remain false. Existing task snapshots should stay immutable; that is different from suppressing the new assessment.

**Required proof:** action-level tests with the render-time version, tenant mismatch, concurrent changes, canonical investigation acceptance, duplicate clicks and transaction failure. Accepted tasks preserve their snapshot and display a new rejected premise without being silently rewritten.

### R8 — shadow and rollback are not yet publication-equivalent

**Priority: high before rollout.** Shadow compares readiness, intervention, change and investigation question only (`shadow.ts:195–201`), not full decisions/visibility/reviews/evidence/accepted tasks. Offline probe adds a legal review requirement and shadow reports **`unchanged`**. It serialises only summaries, not complete proposed packets/decisions suitable for an exact reviewed apply. It has separate projection logic from `publishDecision` and invents fallback dedup identities independently.

Restore (`board-snapshot.ts:189–198`) clears the old record's supersession pointer but does not deactivate its post-snapshot replacement, leaving both eligible as active evidence. It runs row by row without an enclosing transaction, can rewind evidence still used by a preserved newer human task, and can report new-row parking even when the update matched zero rows. Snapshot-time `observedAt` is not a creation/version/concurrency guard.

**Required proof:** a shared pure full projection, identical shadow/apply semantics, reviewable immutable versions and atomic rollback/selection restoration with new-record, human-decision, concurrent-conflict and partial-failure tests. No production rehearsal is necessary for these mechanics.

## Quality evidence: what is and is not established

The saved Susi result is meaningful evidence that the model can use newly retrieved content. It does not establish reliable monthly orchestration, fairness or broad SEO usefulness.

`scripts/evaluate-need-assessment.ts --fresh` separately assembles candidate-synthesis inputs, omits production goals/audience/market/questions/verifier, invents `fresh-*` identities and assesses only the first configured findings. It reuses synthesis/assessment functions but not the same monthly orchestration. Calling this a completed fresh monthly run overstates the evidence. The held-out tenant has no completed fresh-discovery result.

The production bootstrap checks missing documents rather than universally repairing empty usable knowledge. Fact attribution now returns null when no exact matching page exists, but `evidenceUri: null` needs validation against the knowledge writer's actual schema (the evaluation dry run does not exercise persistence). Inventory remains a first-500 query, not full pagination. No rendered retrieval implementation has been added; stripping builder markup is not a universal renderer.

These are additional open package-2/package-6 requirements, not a reason to fabricate positive recommendations or expand into a new system.

## Next assignment for the coding AI

### Title

**Make the evidence-analysis session safe, convergent and replayable.**

### Scope and objective

Implement **R1–R6 only as the next bounded patch** in the existing services. Keep the useful AI evidence loop. An authorised candidate must retrieve material evidence safely, respect the actual run budget, terminate on no progress, preserve exact inputs/attempts and reuse an unchanged completed decision without more model calls. A partial reading must not become an unscoped absence claim.

The canonical corrective plan remains the overall objective. This assignment repairs its failed package-2/3/4 prerequisites; it is not a replacement architecture or permission to mark packages complete. R7–R8 remain release blockers for the following patch. Do not deploy or run more tenant experiments first.

### Files and boundaries

- Primary: `lib/recommendation/{contracts,ledger,packet,assess,run,reassess}.ts`, `lib/research/{runner,finding-evidence}.ts`.
- Reuse/extract the existing crawler safe retrieval helper, existing protected evidence/artifact storage and allowance/reservation facilities as needed. Do not add a separate HTTP/SEO pipeline or parallel budget system.
- Add focused contract/service/orchestration regressions and guarded isolated persistence tests. No redesign of scoring, O1–O12, provider acquisition or the UI in this patch.

### Deliver in this order

1. **Freeze failures:** port the relevant offline counterexamples to repository regressions with desired assertions. Add deterministic mocks for a real `page_text` request, transport retries, redirect chains, zero fetch budget, 429/failure, a body over the byte limit, unchanged expanded replay and a later candidate after repeated first-candidate failure. Show baseline failures before changes.
2. **Safe dispatch and exact accounting:** one runner-owned budget/reservation, no shadowed ledger, every actual model/network retry charged before dispatch; initial reads, fallback and journey reads counted; explicit deadline/byte/input-output limits; no calls at zero. Reuse safe manual redirects and public-address checks on every hop. Do not raise limits to pass tests.
3. **Convergent evidence state:** stable request/content identities and typed completion states; stored complete content before live fetch; requested later sections supported; completed/no-progress requests cannot repeat as if new; failed requests retain diagnostics and do not erase useful earlier observations. Material unresolved evidence is not handed to a customer as routine page-reading work.
4. **Replay and exact archive:** persist complete final packets, dependency versions and all attempt/correction/request results via protected existing storage. Rebuild/revalidate final dependencies for reuse; unchanged inputs produce `reused` with zero new model calls, no new task/decision revision and no duplicate retrieval inside its freshness window. Changed page/source/knowledge/model/prompt/policy invalidates it. A failed attempt is recorded without erasing the previous valid decision. Use fair progress/cursors/backoff for repeated failures.
5. **Scoped coverage:** represent and validate the exact assessed page/section scope. Negative claims on unread sections fail; a scoped finding may justify work only within its evidence scope. Preserve AI judgement and explicit external owner/expert requirements—do not introduce more prose/URL classifiers or force readiness.

### Required pass/fail checks

- Forbidden redirect hop is never dispatched; body/deadline cancellation is verified with mocks.
- Combined new+existing lane consumption cannot exceed the same allowance, even on failed calls/repairs; zero budget means zero dispatches.
- An actual page request supplies the requested body/section, not merely another limitation string; repeat/no-progress termination is bounded and visible.
- Same expanded candidate replay returns `reused`; changing each dependency independently triggers reassessment. Later candidates progress across failed/resumed runs.
- A permitted >200k packet round-trips as complete parseable JSON/artifact with the correct hash; every attempt and failure is retrievable. No clipped JSON is stored.
- A prefix lacking an answer cannot justify a full-page absence/update; a valid scoped positive finding and a genuine external investigation still work without regex-dependent outcomes.
- Production-run-level tests—not only injected assessor happy paths—exercise the orchestration. Unit tests with fixed reasoning prove mechanics only.
- Targeted regressions, TypeScript, full existing test suite, guarded isolated persistence tests and complete build all exit zero; retain full logs/skips. Never source an application database into destructive tests.

### Stop and handoff

Return a small latest-diff review with: exact code commit, baseline failures, actual passing commands, artifact locations, changed contracts and remaining R7–R8/package-6 requirements. Stop for review of this patch before the lifecycle/shadow patch. Do not tune prompts/scores, add tenant conditions, increase budgets, delete/weaken tests or claim packages 1–5 complete.

No live model/provider evaluation, fresh acquisition, application-database migration, publication, merge or deployment is authorised by this assignment. A separate bounded evaluation manifest must be approved before later live acceptance. This review provides instructions; it does not itself implement or dispatch them.
