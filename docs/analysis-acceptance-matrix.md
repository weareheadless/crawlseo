# Analysis acceptance matrix

Every failure in `docs/seo-foundation-audit-2026-11.md`, the code that now prevents it,
and the test that fails if it returns. Status is **implemented** or **open**.

| # | Failure (audit) | Fix | Test | Status |
|---|---|---|---|---|
| 1 | Rank evidence read from the latest 400 raw rows, one per query/page | `lib/funnel/performance-window.ts`, `lib/funnel/gsc-performance.ts`; `backfill.ts` aggregates the window in SQL | `tests/performance-window.test.ts`, `tests/funnel-first-party-demand.test.ts` | implemented |
| 2 | Daily/device/country rows collapsed, losing the window | sums by window, CTR from sums, impression-weighted position, segments declared | `performance-window.test.ts` ("weights position by impressions", "order-independent") | implemented |
| 3 | Superseded months counted twice | `selectCurrentEvidence` keeps the newest `windowEnd` / `crawlId` | `funnel-first-party-demand.test.ts` ("ignores a superseded month") | implemented |
| 4 | Tiny-sample query scored as a top priority | `lib/funnel/impact.ts`: incremental clicks from observed CTR, `hypothesis` when demand is unmeasured | `tests/scoring-honesty.test.ts` | implemented |
| 5 | No demand invention (`volume ?? 120`) | `computeScore` returns a bounded hypothesis index when demand is unknown | `scoring-honesty.test.ts` ("no longer invents demand") | implemented |
| 6 | Technical fixes ranked by page count | `technical` impact: severity + reach, no click estimate | `scoring-honesty.test.ts` ("does not rank a technical fix by page count") | implemented |
| 7 | First-party demand could not create an opportunity | O1 accepts observed impressions with `volumeSource: first_party` | `funnel-first-party-demand.test.ts` | implemented |
| 8 | Script template read as a broken link | `documentMarkup` strips script/style/template/noscript before anchor extraction | `tests/tenant-regressions.test.ts` | implemented |
| 9 | Business-audit "unknown" published as missing schema | `isSchemaAbsence` requires a schema-specific `details.kind`; `schemaType` no longer assumed | `tenant-regressions.test.ts` | implemented |
| 10 | Blocked/challenge pages reported as content defects | `isAssessedPage` gates structural and schema evidence | `tenant-regressions.test.ts` | implemented |
| 11 | Fixed defects never resolved | `selectCurrentEvidence` scopes `onpage_crawl` to the newest crawl | `funnel-first-party-demand.test.ts` | implemented |
| 12 | False "no city pages" claim published | typed `site_claim` + verification; contradicted findings dropped and recorded | `tests/research-site-claims.test.ts` | implemented |
| 13 | Model asserted absence from a 30-URL sample | full page-type inventory + title/H1/description summaries in the prompt | `tests/page-inventory.test.ts` | implemented |
| 14 | Office street used as a research market | `placeToken` rejects street addresses; topics fall back to observed queries | `tests/research-topics.test.ts` | implemented |
| 15 | Empty/PARTIAL run reported as healthy | `inspectTenant` requires sources and findings, reports PARTIAL, adds crawl coverage | open test (readiness integration) | implemented |
| 16 | Paid measurement attached but not used for prioritisation | join re-assesses; `impact` computed from stored inputs | `funnel-join-runner.test.ts` (existing) + `scoring-honesty.test.ts` | partial |
| 17 | Acquisition follows hypotheses instead of observed queries | not implemented | — | **open (P4)** |
| 18 | Cannibalisation/decay asserted as causes | not implemented | — | **open (P5)** |
| 19 | Comparison window / decline detection | `previousWindow` exists; O11 not yet rebuilt on it | `performance-window.test.ts` (window only) | **open (P5)** |
| 20 | Migration, shadow comparison, rollout | not started | — | **open (P9)** |

## Measured effect (read-only, live data, 2026-11-03)

| Site | Ranking evidence before | Query/page pairs in the window | Schema gaps claimed | Schema gaps after |
|---|---:|---:|---:|---:|
| susimacdonald.com | 281 rows / 238 queries | 1,307 pairs / 1,059 queries | 513 | ~127 |
| atelier-harmonie.com | 138 rows / 106 queries | 157 pairs / 143 queries | 157 | ~63 |

The schema figure is the count of pages the crawl actually found without structured
data; the previous number was inflated by 500 and 157 business-consistency "unknown"
observations that are not schema defects.

## Not claimed

- The new numbers are not yet a published board. They are the projection the next
  refresh will use.
- No production data was migrated, no paid collection run, no deployment made.
- Phases P4 (acquisition planning), the remainder of P5 (causal claims, O11 on the
  comparison window) and P9 (migration and rollout) are open.
