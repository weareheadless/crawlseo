# Evidence-analysis safety review — `252df72`

## Verdict

**Changes requested. The safety/convergence/replay assignment is not complete.**

Retain the useful repairs: manual redirect handling, model-attempt callback, removal of the shadowed run ledger, zero-fetch handling, complete unsliced JSON, and the first whole-page/truncated-text check. The patch improves mechanics, but several promised guarantees remain false under adversarial cases. Do not proceed to live tenant experiments or rollout on the current completion report.

Reviewed `252df72`; clean working tree at review start. No production logic was changed, and no live DNS/network/model/provider calls or database writes were made during this review.

Verified now:

- TypeScript: exit 0.
- Four focused files (`recommendation-safety`, `recommendation-regressions`, `recommendation-contract`, `research-finding-evidence`): **39 tests passed**, exit 0.
- Nine offline counterexamples using fake storage, mocked DNS/fetch and direct contract calls. Script: `/tmp/opencode/review-252df72.ts`. Results: `/tmp/opencode/review-252df72-probes.json`.
- Full-suite/build/database/browser/SEO checks were not rerun. Historical green totals are not new review verification.

## Findings, highest priority first

### 1. High — archived packet reuse trusts metadata rather than evidence integrity or current dependencies

**Files:** `lib/recommendation/run.ts:97–130,181–198`; packet decoder in `contracts.ts`.

`findReusableDecision` checks the saved decision against the saved final packet, but never recomputes that packet's content hash. It also accepts an archive when `recommendationInitialPacketHash` is absent, without binding the current candidate/site/project to the archived candidate/site/project. `validateDecision` then compares the decision to the archived packet, not the current identity.

Offline counterexamples:

- Change archived page text without updating its hash: `hashPacket(archive) !== archive.packetHash`, but the decision is reused.
- Omit the initial hash and supply a current packet naming another project/site/finding: the old decision is still reused.

Normal expanded dependencies remain unvalidated too: the current initial selection need not include a requested live/deep page; reusing the old archive does not detect a known changed content version outside that selection. A seven-day age ceiling is not dependency validation. On reuse, `assessFinding` returns the initial `packet` alongside a decision referencing the final packet, so downstream callers cannot validate the returned pair reliably.

**Required repair:** recompute/verify archived hashes, bind identities/current versions, fail closed on absent dependency metadata, and revalidate the final dependency manifest against current versioned storage/cache according to an explicit freshness policy. Return the actual matching final packet with the reused decision. Preserve zero-model replay for unchanged dependencies. Add mutation tests for every dependency, not only an unchanged replay.

### 2. High — network truncation is lost before semantic coverage validation

**Files:** `lib/recommendation/packet.ts:retrievePage`, especially its byte-limit note, and `:750–765`; `buildFullPage`.

`fetchPublicDocument` correctly reports `truncated`. `retrievePage` reduces that to a note. Expansion builds a page with `retrievalNote: null`, and `buildFullPage` derives `truncated` only from the extracted text length. If the first body text is followed by a large script, the byte limit can cut the document before the actual answer; stripping the incomplete script leaves a short text that looks complete.

Offline fixture: introductory text, >2 MB script, then the answer. The resulting packet reports **`truncated: false`, `retrievalNote: null`, request `fulfilled`**. This defeats the new whole-page absence safeguard.

**Required repair:** propagate transport/extraction/section truncation separately, with original status, byte count and extraction scope. No layer may turn incomplete retrieval into whole-page completeness. Test byte truncation and the 120k extracted-text cap through the final packet and validator, not just the HTTP helper.

### 3. High — requests can still claim progress without supplying new evidence

**Files:** `lib/recommendation/packet.ts:720–801,864–877`; `validateEvidenceRequest`.

Offline counterexamples:

- With ten pages already in the packet, fetch an eleventh: it is not inserted, yet the request is `fulfilled` and `progress: true`.
- Request a 25k-character page twice: both rounds supply the identical first 20k characters. The second request is accepted, reports `fulfilled`, and sets `progress: true`.

The status calculation treats `retrieval === "live"` as new progress even when the supplied content is unchanged. Journey progress similarly tests whether any anchors were found, not whether observations were added. Terminal-request matching excludes fulfilled/partial requests and is keyed to incidental target wording, allowing equivalent ID/URL requests to evade it.

Complete stored body text is still not consulted before a live re-fetch, and there is no request contract for a later offset/section. Merely increasing page/text limits is not a repair.

**Required repair:** canonical request identity, actual before/after evidence comparison, explicit capacity/partial results, stored full text first, and a bounded later-section request. Count fulfillment only when the exact requested evidence was supplied. Persist all outcomes without silently dropping limitations. Add tests for full packet capacity, long pages, repeated anchors and equivalent URL/ID requests.

### 4. High — aggregate byte/time limits are admission checks, not enforced limits

**Files:** `lib/recommendation/ledger.ts:49–63,96–117`; `run.ts:263–272`; `packet.ts` retrieval calls; `lib/ai/chat.ts:63–80`.

`canFetch()` allows a request whenever the cumulative byte count is below the cap, but the HTTP helper receives its independent 2 MB allowance. Bytes are charged only after the response. Offline accounting probe: with **24 bytes remaining**, another request is admitted and the count reaches **2,500 bytes against a 1,024-byte allowance**. Aborted/throwing reads report zero bytes, so repeated failed reads can escape the aggregate byte accounting.

The wall-clock cap is checked before work, but it is not propagated as an absolute deadline to DNS, model requests, body readers, queue waits or backoff. `chatJson.beforeAttempt` runs before entering the serialisation queue, not immediately before network dispatch; a queued request can cross its deadline before it is actually sent. A per-call output token ceiling does not establish aggregate token/spend reservations.

**Required repair:** reserve/pass the exact remaining bytes, reject at zero without clamping upward, account streamed partial reads even on failure, and pass a cancellable absolute deadline through queue/retry/DNS/fetch/model execution. Use the existing allowance/reservation mechanism where spend is claimed; do not equate request counts with cost guarantees or increase limits to pass.

### 5. High — site-origin restrictions are still checked after redirect dispatch

**Files:** `lib/recommendation/packet.ts:retrievePage`; `lib/crawler/engine.ts:445–486`; inherited `isPrivateIp`.

The helper blocks some private destinations before dispatch, which is an improvement. But the recommendation layer checks the final host only after the helper returns. Its `beforeHop` callback does not validate that hop's origin.

Offline probe: `https://site.test/start` redirects to `https://outside.test/page`; both are dispatched before the result becomes `unavailable: redirect left the site domain`. The address classifier also permits the non-public shared range `100.64.0.0/10`; the mocked `100.64.1.2` destination is dispatched. IPv6/private-range coverage and binding the validated DNS result to the actual connection also need explicit tests, not assumptions from a separate lookup.

**Required repair:** enforce the authorised origin policy on every hop before dispatch; validate all resolved addresses using a complete appropriate public-address policy and ensure the connection uses a validated resolution. Test these through the recommendation retrieval boundary, not only a helper with a happy-path resolver.

### 6. High — section-scoped evidence is not bound to the section being changed

**Files:** `lib/recommendation/contracts.ts:562–577` and target checks around `:640–658`.

The validator checks that coverage section IDs exist, but target validation checks only page-level coverage. It does not verify that `target.sectionId` exists or belongs to the assessed scope.

Offline probe: assess `section:0`, propose changing `section:never-supplied` on the same page; the actionable decision passes validation with no errors. A model can therefore relabel a whole-page negative claim as section-scoped without grounding the actual intervention in that section.

The existing investigation guard still decides meaning by URL/ID substring presence (`contracts.ts:604–611`). That unresolved review finding was not repaired.

**Required repair:** validate every target section and its relationship to assessed scope. A section-local absence must not authorise an uninspected different section or whole-page intervention. Represent external owner/expert requirements explicitly rather than classifying prose by embedded URLs. Retain useful scoped positive changes and genuinely external investigations.

### 7. High — complete attempt/packet archival still fails on failure paths

**Files:** `lib/ai/chat.ts`, `lib/recommendation/assess.ts:135–155`, `run.ts:64–90,224–226,307–327,363–377`.

Unsliced successful JSON is fixed. But transport errors and malformed JSON do not enter `rawAttempts`; the chat helper throws before exposing the response. A failed reassessment with prior evidence saves only its last `raw`, a packet hash and a ledger—not the failed packet, ordered attempts, corrections or request outcomes. The failure writer catches and logs persistence failure, so there is no durable-archive guarantee. Invalid final validation returns without recording a quality event. Read-only results expose only the last raw response, not the full attempt history either.

The raw attempt list also lacks the corresponding input packet version, feedback and validation result for each attempt. Replaying an assessment requires more than a list of successful parsed objects and the final packet.

**Required repair:** one structured append-only attempt envelope for all result paths, with exact input/artifact refs, raw output/error, validation/correction, request results and accounting. Preserve the previous valid decision without losing failure evidence. Record archive failure explicitly and refuse to claim an auditable outcome when persistence fails. Test real response/parse/timeout errors, not only injected `{ kind: "failure" }` values.

## Other unresolved requirements from the assignment

- Reassessment is still oldest-first with no persistent progress/backoff cursor; repeated earliest failures can starve later candidates.
- The resume bridge repair is useful but the runner can still revisit the same failed candidate in the reassessment lane. A shared counter alone does not prove fair candidate progress.
- No failing-regression baseline was recorded before the implementation. The new tests were written after code changes; the one reported new-test failure was an expected 1000-vs-clamped-1024 byte mismatch, not the required pre-fix behaviour baseline.
- The new transport-accounting test uses one nonretryable HTTP 400 and `maxAttempts: 1`; it does not prove retries or queue/deadline limits. The replay test uses `source_text` (no page retrieved), not a changed expanded page dependency. The persistence test is fake storage, not a >200k isolated database round trip.
- The immediate assignment required production-orchestration and persistence tests, but the new cases mainly use direct service calls and injected reasoning. Keep existing green tests; add the missing boundary tests rather than weaken them.
- Previously identified lifecycle/acceptance and shadow/rollback defects remain separate blockers. Do not begin those as a way to declare this safety assignment complete.

## Next step

Finish **this same assignment**, not another redesign or new tenant experiment. Work in two reviewable subpatches:

1. **Retrieval/convergence/scoped evidence:** findings 2–6. First preserve each probe as a failing repository regression. Fix before-hop origin/address policy, streamed remaining-byte/deadline enforcement, truncation propagation, actual evidence progress/capacity, later-section access and target-to-scope integrity. No larger budgets or semantic URL/regex classifiers.
2. **Replay/attempt archive/orchestration:** findings 1 and 7 plus fairness. Add an exact versioned dependency manifest and verified archived hashes, matching packet/decision returns, complete per-attempt input/output/error history, archive failure behaviour, and persistent candidate progress. Prove unchanged expanded replay and independently changed dependencies through the actual orchestration and isolated storage.

Use one decision-maker and existing retrieval/evidence/budget facilities. Do not touch scoring/O1–O12 or loosen source content/expected behaviour. Preserve the useful Susi reading result; it remains historical quality evidence, not permission for another unbounded live evaluation.

Return actual failing-before/passing-after results, complete command exit codes and a latest-diff review before claiming the assignment repaired. No paid evaluation, application-database changes, publication, merge or deployment is authorised by this review. Overall SEO usefulness and independent same-evidence review remain pending after these engineering repairs.

## Resolution

Repaired in the follow-up patches. See
`docs/recommendation-analysis-safety-252df72-repair.md` for the per-finding
safety implementation and `docs/recommendation-lifecycle-shadow-repair.md` for
R7 lifecycle/acceptance and R8 shadow/rollback. R7 and R8 are no longer release
blockers. This resolution does not authorise a live evaluation,
application-database migration, publication, merge or deployment.
