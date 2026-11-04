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
| 16 | Paid measurement attached but not used for prioritisation | `runAcquisitionPlan` measures observed queries first; new volume re-runs detection | `tests/funnel-acquisition.test.ts` | implemented |
| 17 | Acquisition follows hypotheses instead of observed queries | observed performance is planned first, by impressions, batched, cached 45 days | `funnel-acquisition.test.ts` | implemented |
| 18 | Cannibalisation/decay asserted as causes | O10 needs observed overlap and asks for a check; O11 states the movement and says the cause is not established | `tests/funnel-decline-overlap.test.ts` | implemented |
| 19 | Comparison window / decline detection | backfill stores the previous window; O11 compares it | `funnel-decline-overlap.test.ts` | implemented |
| 20 | Migration, shadow comparison, rollout | `assessmentVersion` migration, `--dry-run`, `scripts/shadow-analysis.ts`, `scripts/reanalyse-all.ts` with snapshot/restore | executed on production | implemented |

Additional correctness added while reviewing the shadow diff:

| # | Failure | Fix | Test |
|---|---|---|---|
| 21 | Provider volume claimed upside the site was never shown for | `assessImpact` bounds reach by observed impressions | `scoring-honesty.test.ts` ("reach bound") |
| 22 | Off-offer traffic topped the board (hospital queries on a property site) | unknown business relevance dampens the index; per-query relevance tested against knowledge | `funnel-first-party-demand.test.ts` |
| 23 | The site's own name offered as a winnable rank | `isBrandQuery` + domain-derived brand terms | `funnel-first-party-demand.test.ts` |
| 24 | A top-ten page with 0% CTR was invisible | O2 covers the snippet band, not only 11–20 | `funnel-first-party-demand.test.ts` ("snippet opportunity") |

## P4 exercised on production (2026-11-04)

`tenant.ts --site <susi> --apply` ran the acquisition pass:

```
acquisition  20/40 measured (10 cached, 20 no data, 0 failed), $0.029
```

Twenty exact measurements now sit against queries the site is observed for
(`akumal real estate`, `beachfront homes for sale under $100k in mexico`,
`hospitales cancun`, …), where before every measured phrase was disjoint from the
ranking set. The provider simply has no volume for the other twenty, which is
recorded as `no_data` rather than a failure.

## Applied to production (2026-11-04, commit `1e6bced`)

- Migration `20261104150000_opportunity_assessment_version` deployed (additive).
- Board refreshed for every live tenant with a rollback snapshot in
  `.releases/board/`; `scripts/reanalyse-all.ts --restore <file>` reverts it.
- Duplicate site record retired (`scripts/retire-duplicate-sites.ts`).
- Worker and web released at `1e6bced`.

## Published boards after the refresh (2026-11-04)

| Site | Detected | measured | estimated | technical | hypothesis |
|---|---:|---:|---:|---:|---:|
| susimacdonald.com | 49 | 16 | 0 | 10 | 23 |
| atelier-harmonie.com | 59 | 3 | 0 | 21 | 35 |
| oceanicvibes.com | 26 | 0 | 0 | 16 | 10 |
| casamigo.net | 29 | 0 | 0 | 20 | 9 |

Susi's top row is now the measured "beachfront homes for sale under $100k"
(269 impressions, 10 clicks, position 6.9), not a page-count defect. Atelier,
Oceanic and Casamigo lead with technical work because no query has enough
impressions to measure an upside — the honest result, not a ranking bug.

Oceanic now resolves en/US with the business in MX (previously es/MX).

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
