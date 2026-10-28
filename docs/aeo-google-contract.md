# Google AI Overviews evaluator contract (UI-052)

`evaluateGoogleAiOverviewQuestion` in `lib/aeo/google-ai-overview.ts` makes one DataForSEO Google organic SERP live/advanced request and returns local normalized evidence. It performs no persistence or orchestration. The caller supplies a question, pinned locale (`languageCode`, DataForSEO `locationCode`), device, project ID, and optional brand plus aliases. A request uses that exact locale and device; desktop is pinned to Windows, mobile to Android.

## Result and absence semantics

The result has a `state` of `succeeded`, `overview_absent`, `request_failed`, `rate_limited`, or `over_budget`, plus provider, exact question, locale, device, cost in micros, task ID, answer text, citation URLs, referenced domains, brand verdict and safe error text. The caller may set `overBudget: true` after applying its run budget policy; the adapter returns `over_budget` before credential lookup or HTTP. The adapter does not own or calculate the budget. Citations and domains are deduplicated and bounded.

`overview_absent` means a valid SERP response contained no `ai_overview` item. It is not an absence of the requested brand and not a failed call. A present overview with an explicitly supplied brand and aliases reports `brandPresent: true|false`; without a brand target it is null. Provider errors, invalid JSON/shape, missing answer text, timeouts and oversized replies never become `overview_absent`. Request failures are outcomes only and must not be persisted as observations. A valid absent-overview SERP can be represented downstream as an answer-absent observation per the UI-050 contract.

## Credentials and request bounds

Credentials are resolved server-side from the active project's existing DataForSEO grant, preferring its active platform credential and otherwise using the project's existing encrypted API-key record. Platform credentials are provisioned through the existing `CRAWLSEO_DATAFORSEO_LOGIN` / `CRAWLSEO_DATAFORSEO_PASSWORD` path; no new credential model is introduced. Missing/inactive credentials return a clear configuration failure before HTTP. Credentials are never included in errors or logs.

The adapter makes one request only (no retry), aborts after 15 seconds, and rejects response bodies over 2 MB. HTTP 429 is classified separately; 401/403 are configuration failures; other HTTP/provider/server failures are request failures. No live paid request is needed for the fixture tests.
