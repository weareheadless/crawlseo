# Evidence-analysis safety repair — `252df72` review

## Verdict

All seven findings and the fairness requirement in
`docs/recommendation-analysis-review-252df72.md` are repaired in this patch.
R7 lifecycle/acceptance and R8 shadow/rollback remain separate release blockers.
No live model/provider calls, production database writes, publication, merge or
deployment were performed.

## Failing baseline

The reviewer recorded nine counterexamples at `252df72`; the durable copy is
`docs/recommendation-analysis-review-252df72-baseline.json`:

- off-origin redirect dispatched before rejection;
- `100.64.1.2` accepted by the address policy;
- altered archived text reused despite a hash mismatch;
- missing initial identity reused across project/site/finding;
- byte-capped HTML reported as complete, `fulfilled`;
- an omitted eleventh page reported as `fulfilled` with progress;
- a repeated 20k prefix reported as `fulfilled` with progress;
- a section-local assessment authorising `section:never-supplied`;
- 24 remaining bytes admitting a response that reached 2,500 bytes.

Those cases are now repository regressions in
`tests/recommendation-safety-252df72.test.ts` (33 tests). The baseline JSON is the
failing-before record.

## Repairs

### 1. Replay trusts verified content and current dependencies

`lib/recommendation/run.ts`, `lib/recommendation/contracts.ts`

- `findReusableDecision` is async and requires:
  - the stored initial packet hash, equal to the freshly built initial packet;
  - the archived final packet, whose content hash is recomputed and must match;
  - matching project, site, candidate and dedup identities;
  - successful `validateDecision` against the archived final packet;
  - a stored dependency manifest that matches a manifest recomputed from the
    final packet.
- The dependency manifest covers stored page content hashes, source excerpt
  hashes and observation times, business-knowledge revision and search record
  identities. Stored pages are checked against the latest completed crawl.
- Live pages cannot be version-checked without a new fetch; they are reusable
  only inside the explicit `reuseMaxAgeDays` window and only when the archived
  retrieval was not truncated.
- Reuse returns the actual archived final packet with the decision.
- Decisions without an initial hash or dependency manifest are no longer reused;
  they are reassessed once. This is a deliberate fail-closed migration.

### 2. Truncation reaches the packet and validator

`lib/recommendation/packet.ts`, `lib/crawler/engine.ts`

- `fetchPublicDocument` returns transport truncation; `retrievePage` distinguishes
  the 120k extracted-text cap from a transport byte cap.
- `PacketPage` now carries `offset` and `truncation` (`sectioned`, `byte_limit`,
  `text_limit`, `offset`, `none`).
- Requested pages preserve transport truncation and retrieval notes; a byte-capped
  document is never marked complete.
- A truncated page cannot support a whole-page absence claim; section-scoped
  coverage is required.
- `sealPacket` hashes the JSON form that will be persisted, so optional in-memory
  `undefined` properties cannot make a stored packet fail its own hash check.

### 3. Requests converge on real evidence

`lib/recommendation/packet.ts`, `lib/recommendation/contracts.ts`

- Canonical request keys normalise page ids and URLs, so equivalent wording
  cannot evade history.
- Fulfilment requires changed evidence. Capacity, exhausted live text, byte caps
  and repeated prefixes produce `partial`, `no_progress`, `budget_exhausted` or
  `unavailable` with an explicit detail.
- Stored crawl text is read before any live fetch.
- `offset` is part of the request contract. A repeated truncated request
  automatically continues after the supplied text; the next request can name an
  explicit offset.
- Journey-link progress counts newly added anchors, not anchors already present.
- Limitations are de-duplicated; overflow is recorded in the trace and
  summarised rather than silently dropped.

### 4. Bytes and time are enforced, not admitted

`lib/crawler/engine.ts`, `lib/recommendation/ledger.ts`,
`lib/recommendation/run.ts`, `lib/ai/chat.ts`

- Retrieval receives the exact remaining byte allowance. Zero or negative means
  no dispatch; the previous 1,024-byte floor is gone.
- Every chunk read is charged through `onBytes`, including partial and aborted
  reads. The body reader cannot exceed the granted allowance.
- `AnalysisLedger` exposes `remainingBytes`, `deadlineAt` and `remainingMs`.
- The absolute deadline is passed to DNS resolution, the HTTP transport, the
  model queue, retries and backoff.
- `chatJson.beforeAttempt` now runs inside the serialised queue immediately
  before dispatch, so a queued request cannot cross its deadline and still spend
  budget.

### 5. Origin and address policy are checked before every hop

`lib/crawler/engine.ts`, `lib/recommendation/packet.ts`

- `fetchPublicDocument` accepts an `allowedHost` policy and checks it on every
  redirect hop before dispatch.
- `retrievePage` enforces the site origin on every hop, not only on the final
  result.
- The public-address policy now rejects carrier-grade NAT (`100.64.0.0/10`),
  documentation, benchmarking, multicast, reserved and IPv4-mapped ranges, plus
  the corresponding IPv6 ranges.
- The validated address is pinned into the connection's `lookup`, removing the
  DNS-rebinding window.

### 6. Section evidence is bound to the section being changed

`lib/recommendation/contracts.ts`

- Every target section must exist in the supplied page.
- A section-scoped negative assessment cannot authorise a whole-page change.
- A target section must be one of the assessed `sectionIds`.
- Investigation guards now match only exact packet ids/URLs. Prose that mentions
  a URL is not reclassified by substring. Investigations require an explicit
  `kind` (`owner_input`, `qualified_review`, `private_data`,
  `external_evidence`).

### 7. Attempt history is archived on every path

`lib/ai/chat.ts`, `lib/recommendation/assess.ts`, `lib/recommendation/run.ts`

- Every transport attempt exposes a record with status, error and raw provider
  text, including HTTP errors, malformed JSON and timeouts.
- `AssessmentAttempt` records the round, attempt, input packet hash, feedback,
  outcome kind, raw output/error and validation errors.
- Successful, invalid, failed and read-only results all return the attempt
  history.
- Failed reassessment archives the failed packet, initial hash, dependency
  manifest, ordered attempts, request outcomes, trace and ledger while preserving
  the previous valid decision.
- An archive-write failure is reported in the result instead of being swallowed.
- Invalid final validation records a failure event rather than returning silently.

### Fairness

`lib/recommendation/reassess.ts`

- Candidate order is sorted by the latest persisted attempt (stored in the
  existing `RawProviderResponse` table), so a repeatedly failing early candidate
  moves behind candidates that have not had a turn.
- Progress is recorded after assessed and failed attempts; dry-run status now
  uses the same verified reuse check rather than comparing only the initial hash.
- A recently failed candidate is skipped for 30 minutes instead of being retried
  twice in the same reassessment lane.

## Verification

```
npx tsc --noEmit                                      # exit 0
npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'
# 1,025 passed, 18 skipped
DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 \
  npx vitest run tests/customer-recommendations-postgres.integration.test.ts
# 6 passed (includes a >200k packet round trip, expanded replay and changed-dependency invalidation)
npm run build                                         # exit 0, compiled successfully
```

The 33 offline regressions cover: off-origin redirect, reserved address ranges
and pinned-address delivery, archived hash tampering, missing identity, changed
page/source/business-knowledge/search dependencies, live-page and freshness
invalidity, missing dependency metadata, transport truncation and the 120k
extracted-text cap, packet capacity, long-page continuation, URL/id request
equivalence, byte accounting and partial reads on failure, zero-byte and expired
retrieval, retries, malformed JSON, timeouts, invalid output, target-section
scope, scoped positive changes, external investigation prose, transport-failure
history, failed-reassessment archival and archive-write failure, stored-text-first
retrieval, journey-link no-progress, fair reassessment order and failure backoff.

The disposable-schema integration suite covers a real expanded replay (an
evidence request followed by a final decision), invalidation after a stored page
changes, and a packet above 200k characters persisted and reused through the
actual orchestration.

## Remaining blockers

- R7 lifecycle/acceptance: render-time version, canonical investigation
  acceptance and accepted-premise change visibility.
- R8 shadow/rollback equivalence and atomic evidence restoration.
- Independent SEO/business review, held-out fresh monthly discovery, full
  all-tenant shadow diff, browser/accessibility validation and production
  rollout.

Green tests and this report are not approval for a live tenant evaluation,
application-database migration, publication, merge or deployment.
