# OPS-003 production prelaunch research verification

**Result: blocked at production authorization; no paid research was run.**

## Baseline and target

- Fresh `main` checkout: `81ad3e6b44444c8283ad2099b1aa047ce304d6c6`; OPS-010
  (`0f48d778`) is an ancestor. `npm ci` and `npx prisma generate` succeeded.
- Production API health returned HTTP 200. Its response has no source SHA, so
  this does not prove which API build was serving requests.
- Target: internal `ada-provision-test` only (project
  `cmuls0r2n0002oyqfmv86i92z`; synthetic site domain
  `ada-provision-test.helloada.app`). No customer project was accessed.
- Production environment was sourced from `/SEO/.env.local`; neither its
  contents nor credential values are included here.

## Fixed budget

The budget endpoint initially reported no allowance or ceiling, USD, UTC,
revision 1, and zero committed/reserved micros. Through the authenticated budget
API, the test project was then configured with the exact authorized caps:

- Monthly allowance: **USD 1.00** (`1,000,000` micros)
- Per-operation ceiling: **USD 0.10** (`100,000` micros)

The PUT returned HTTP 200, revision 2, with both exact values. After the
research request was rejected, a read-only Prisma check confirmed the same
budget, no research run for the selected period, and no October reservations.
The budget remains configured at those caps as requested.

The successful budget PUT body (service credential redacted):

```json
{
  "siteId": "cmuls0r2v0004oyqfcbjnqwxq",
  "expectedRevision": 1,
  "monthlyAllowanceMicros": "1000000",
  "maxOperationMicros": "100000",
  "currency": "USD",
  "timeZone": "UTC"
}
```

Response: HTTP 200; `policy` returned project/site IDs, revision `2`,
`monthlyAllowanceMicros: "1000000"`, `maxOperationMicros: "100000"`,
`currency: "USD"`, and `timeZone: "UTC"`. The preceding budget GET returned
HTTP 200 with `configured: false`, null allowance/ceiling, and zero committed
and reserved micros. One preliminary GET mistakenly omitted the `/crawlseo`
mount prefix and got an HTML 404; it made no mutation and was corrected before
the successful GET/PUT.

## Request and exact response

A short-lived project credential was issued through the existing service
credential issuer with only `connector:read`, `connector:write`,
`seo:research:request`, and `document:read`; pre-existing credentials were not
revoked. It was revoked after the attempt. The live budget API accepted it, but
the prelaunch endpoint did not.

The single intended request was sent to the production mount at
`/crawlseo/api/projects/cmuls0r2n0002oyqfmv86i92z/prelaunch-research` with
`Authorization: Bearer [REDACTED]` and this body:

```json
{
  "brief": {
    "period": "2026-09",
    "focus_market": { "language": "en", "country": "US" },
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

Response: **HTTP 403**

```json
{"error":"Service credential lacks required scope"}
```

The credential carried `seo:research:request`, as required by merged OPS-010,
yet the live endpoint still rejected it. The runtime's exact deployed SHA could
not be established. Per the issue instruction, I stopped: no alternate scope,
credential bypass, retry, or replay was attempted.

## Spend, task and replay evidence

- Total spend: **USD 0.00**; no provider operation was invoked.
- No run ID was returned; no run or task rows exist for the selected period.
- No reservation or settlement rows exist for the current budget period.
- Domain-dependent tasks, findings, source receipts, task skip reasons and
  settled provider charges are unavailable because the request was rejected
  before run creation. The body omitted a competitor and supplied no verified
  public business domain; those skips were not confirmed by a completed run.
  The submitted bakery profile was a synthetic throwaway profile, not a named
  real business; it was not forwarded to the provider.
- Replay was not attempted because the first request was rejected.
- The test project had no canonical business-knowledge document at preflight;
  none was created. The contract shape is
  `schemaVersion: "business-knowledge/1"`, `kind: "business_document"`,
  `workspaceId`, `projectId`, `documentId`, `revision`, `state`, `updatedAt`,
  `acceptedRevision`, and `fields` (optional facts for business name, services,
  location, service area, differentiators, trust evidence, audience motivations,
  concerns, conversion goals, voice, and prohibited claims). No actual document
  or research-report shape could be read back.

## Remaining acceptance gap and state

This is not successful live provider verification. The project remains an
internal test project with the requested USD 1.00 / USD 0.10 budget, no
research runs or reservations, and no canonical knowledge document. Temporary
credentials created for the budget and request attempts were revoked; existing
credentials were left unchanged. Rerun only after the live endpoint accepts
`seo:research:request`, while retaining the same caps.
