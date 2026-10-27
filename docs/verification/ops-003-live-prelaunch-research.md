# OPS-003 production prelaunch research verification

**Result: request accepted, but the queued run did not execute. No paid
provider work or completed-run replay occurred.**

## Baseline, target and budget

- Fresh `main`: `81ad3e6b44444c8283ad2099b1aa047ce304d6c6`, including
  OPS-010 `0f48d778`. `npm ci` and `npx prisma generate` passed. Production
  health returned HTTP 200 but exposes no source SHA.
- Only target: internal `ada-provision-test` (project
  `cmuls0r2n0002oyqfmv86i92z`; synthetic site
  `ada-provision-test.helloada.app`). No customer project was changed.
- `/SEO/.env.local` was sourced without printing or recording its contents.
- The budget was set through the authenticated budget API to USD 1.00 monthly
  (`1,000,000` micros) and USD 0.10 per operation (`100,000` micros), USD/UTC,
  revision 2. It remains at these exact caps.
- Budget PUT body (credential redacted):

  ```json
  {"siteId":"cmuls0r2v0004oyqfcbjnqwxq","expectedRevision":1,"monthlyAllowanceMicros":"1000000","maxOperationMicros":"100000","currency":"USD","timeZone":"UTC"}
  ```

  Response: HTTP 200, revision 2 and both exact caps. Before configuration,
  budget GET returned HTTP 200, `configured:false`, null caps, and zero
  committed/reserved micros. An earlier diagnostic GET omitted the `/crawlseo`
  mount prefix and returned HTML 404; it caused no mutation.

## Retry request and response

The pre-deployment request had returned HTTP 403
`{"error":"Service credential lacks required scope"}`. After the reported
scope-fix deployment, I issued one fresh project-scoped
`seo:research:request` credential through the existing issuer and sent exactly
one retry with the same body and idempotency key. The temporary credential was
revoked afterward; existing credentials were not revoked.

POST path: `/crawlseo/api/projects/cmuls0r2n0002oyqfmv86i92z/prelaunch-research`

```json
{
  "brief": {
    "period": "2026-09",
    "focus_market": {"language":"en","country":"US"},
    "business_goal": "Improve local discovery for a throwaway test profile representing a small, owner-operated neighborhood bakery offering artisan breads, pastries, and custom cakes.",
    "audience": ["nearby residents looking for fresh bread and pastries", "families ordering custom celebration cakes", "local offices arranging small catering orders"],
    "priority_services": ["artisan bread", "fresh pastries", "custom cakes"],
    "keyword_seeds": ["neighborhood bakery", "artisan sourdough bakery", "custom birthday cakes", "fresh pastries bakery", "small office bakery catering"],
    "competitor": null,
    "research_questions": ["Which local search terms show demand for bakery products?", "How do customers search for custom cakes and bakery catering?"],
    "selection_rationale": {
      "market": "English-language US local search is the bounded test market for this internal throwaway profile.",
      "seeds": ["Local bakery category intent", "artisan bread product intent", "custom cake service intent", "fresh pastry product intent", "small office catering service intent"],
      "competitor": "No verified business domain or competitor was supplied for this test project; domain-dependent research is intentionally omitted."
    },
    "package": "standard-v1"
  },
  "idempotency_key": "ops-003-live-prelaunch-20261027-ada-provision-test"
}
```

Response: **HTTP 200**

```json
{"report_id":"cmvqm9i130001oyri2trh7hdx","project_id":"cmuls0r2n0002oyqfmv86i92z","period":"2026-09","status":"requested","task_limit":9,"task_count":5,"existing":false}
```

## Accepted run: queue failure before provider execution

I waited 30 minutes. Read-only Prisma inspection at `2026-10-27T12:14:37Z`
found:

- One `SeoResearchRun`: `cmvqm9i130001oyri2trh7hdx`, status `REQUESTED`,
  `taskCount:5`, `attemptedCount:0`, `actualCostMicros:0`, no `startedAt`,
  `completedAt`, report or source manifest.
- Five `SeoResearchTask` rows, all `RESERVED`; all have null
  `attemptedAt`, `providerTaskId`, cost and error. Thus provider calls: **0**.
- One `SEO_RESEARCH` job for this run is `FAILED`, attempts `10/10`, with no
  lease/heartbeat and null `lastErrorCode`. The run remained `REQUESTED`, so
  the prelaunch runner did not start. The runner code transitions to
  `RUNNING_PAID_RESEARCH` before task execution. The queue code marks an
  expired lease `FAILED` once attempts reach the maximum without persisting an
  error code. These rows are consistent with exhausted worker leases, but do
  not identify why the lease expired.
- Five matching reservations are still `RESERVED` at `100,000` micros each:
  **USD 0.50 held**, with no settlements or provider task IDs. Actual spend is
  **USD 0.00**; the monthly cap remains USD 1.00 and no per-operation cap was
  raised.
- The idempotency mapping exists once. Project-wide `ResearchAction` count is
  3, unchanged from preflight; zero actions, `ResearchFinding` rows, or
  `ResearchSource` rows are linked to this prelaunch run. The project had no
  canonical business-knowledge document before or after; none was written.
- The report GET and identical-request replay were not attempted because the
  accepted run never completed. No replay/no-duplicate-spend proof is claimed.
  No worker/job reset, manual dispatch, or additional POST was attempted.

The task plan contained five keyword seeds. Domain-dependent work was not
executed: the current prelaunch runner's defined skip reasons are no domain for
own-domain overview and backlinks, no site integrations for GSC/GA4, no site
for crawl history, and no selected competitor. Those report skips are not yet
persisted because the runner never started. The submitted bakery profile was a
synthetic throwaway profile, not a named real business; the accepted request's
queued job failed before any provider saw the profile.

## Separate symptom: six existing `ResearchRun` rows are PARTIAL

Read-only inspection found six production `ResearchRun` rows, each with
`errorCode: PARTIAL_SOURCE_FAILURES`; every report contains one or more
`Reddit RSS returned HTTP 429` source errors. Together they have **117 saved
source rows, 33 finding rows and 32 action rows** (all per-run row counts were
nonzero). The error-count distribution per row is 1, 2, 4, 4, 4, and 3.

The runner defines PARTIAL as `sourceErrors.length > 0 || savedSourceCount ===
0`. Its Reddit provider throws on non-2xx responses, and the runner records the
429 errors while still synthesizing findings/actions from other saved sources.
So PARTIAL does not mean those runs have no results. Three newer reports also
show freshness filtering (15, 36 and 22 stale items respectively), but each
still saved at least one source; the Reddit 429s explain their PARTIAL status.
This task did not alter those runs or fix the separate owner-visible symptom;
the dashboard rendering was not verified.

## Handoff

The test project remains with the requested budget, one accepted but unexecuted
run, five reserved tasks, USD 0.50 held and USD 0.00 spent. The async job
exhausted its attempts before provider execution. Acceptance remains incomplete:
there are no provider findings/sources, no completed run, no replay proof, and
no canonical knowledge document. All temporary service credentials were
revoked. Do not claim paid live verification from the HTTP 200.
