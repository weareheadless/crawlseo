# SEO foundation audit — November 2026

## Verdict and scope

The current boards are not reliable SEO strategy outputs. Cross-tenant failures exist in crawl extraction, evidence projection, research scope, paid-data integration, detection and scoring. More provider data or a prompt/sampler fix alone will not repair this.

This investigation used read-only database queries, code inspection and one live fetch of Casamigo's Cancun page. No production data was changed, paid collection run, or deployment performed. Earlier uncommitted sampler changes remain uncommitted. Figures describe the observations stored at inspection time, not an independently complete measurement of Google visibility. 28-day queries used the database/application clock.

## 1. Existing ranking data is discarded and its grain changed

`lib/funnel/backfill.ts:187–215` reads at most 400 Keyword rows, ordered only by date, then keeps the first row per query/page. Raw Keyword rows include date, device and country (`prisma/schema.prisma:1587–1604`). These are not aggregate query/page performance observations. Device/country disappear in the projected evidence; the chosen observation can be a single impression. There is no 28-day aggregate for ranking detection.

Susi has 41,735 stored Keyword rows and 2,623 distinct queries historically. The last 28 days contain 5,938 rows, 986 queries and 7,636 query-row impressions. The funnel holds 281 rank evidence rows covering just 238 distinct queries. The evidence set can also contain older observations; it is not a clean current-window universe.

Examples from raw Susi query/page aggregates over 28 days:

| Query | Impressions | Clicks | Impression-weighted position |
|---|---:|---:|---:|
| beachfront homes for sale under $100k | 269 | 10 | 6.90 |
| puerto morelos condos for sale — city landing page | 58 | 0 | 12.74 |
| akumal real estate — condos landing page | 48 | 0 | 16.81 |
| is puerto aventuras safe | 47 | 0 | 6.34 |

These are investigation candidates, not automatic recommendations. Affordability intent must match real inventory; hospital/safety traffic needs a demonstrated route to qualified real-estate enquiries. A competent review would inspect the landing pages, audience, SERP intent and current offer before recommending work.

## 2. Atelier's top score is not supported as a priority

The stored rank observation for `art et tapisserie` is two impressions, zero clicks, position 7, France/mobile, on October 19. Provider keyword evidence records 3,600 searches/month. Thus the user-visible concern is correct in substance, although the inspected evidence contains two impressions rather than one.

`lib/funnel/detectors.ts:293–327` permits O1 when position is 4–10 and volume is at least 10. It does not require a meaningful observation sample, stability, verified intent or rank confirmation. It supplies fixed business value 0.7 and default competition/page-strength inputs. The stored score inputs use volume 3,600 and CTR 0.04, producing the published high score. It is a hypothesis to validate, not a defensible top priority.

`lib/funnel/scoring.ts:99–143` mixes monthly search demand with observed impressions elsewhere, defaults unknown volume to 120, and scores total potential clicks rather than incremental clicks relative to current performance. It does not establish a target-rank uplift, audience reach, conversion value or evidence uncertainty. The saturating 0–100 curve is not an empirically calibrated probability or return estimate. The recent 0.1 technical uplift and O5 cap do not repair these semantics.

## 3. Paid collection does not reliably feed opportunity selection or scoring

Susi has 14 keyword-metric evidence rows representing seven distinct measured phrases. None exactly match its ranking-evidence query phrases. O1 joins rank and volume by exact query string, so none of those measured phrases can create Susi O1 candidates through that path. O1 has no GSC-only opportunity path when volume is absent. O2 uses the unaggregated row's impressions and only covers positions 11–20.

`lib/dataforseo/join-collectors.ts` derives a keyword from an already-generated research finding. `lib/funnel/join-runner.ts:248–281` selects paid collectors for O13/O14, rather than enriching the complete existing ranking universe. This makes spending follow generated hypotheses instead of systematically diagnosing existing search performance.

`lib/funnel/join.ts:76–118` adds supporting evidence and recomputes completeness/freshness using existing score inputs; it does not extract new search volume or competition into worth/win-probability inputs. A finding can become “both” without its score reflecting its newly measured demand.

Other detector defects: O10 treats multiple ranking URLs as proof of harmful cannibalisation and tells the user to consolidate. O10/O11 read volume directly from rank evidence even though keyword metrics are stored separately (`detectors.ts:605–665`). Position deterioration alone is labelled freshness decay without proving freshness as the cause.

This audit does not reconcile all provider invoices or quantify wasted dollars. The verified issue is that paid evidence does not reliably influence actionable prioritisation.

## 4. The technical board misrepresents crawl facts

The latest inspected crawl has 157 pages for Atelier and 500 for Susi. Susi reaches its configured 500-page cap: COMPLETED does not prove complete site coverage. Atelier contains eight 429/challenge pages and Susi nineteen. Those responses are present in the audit dataset; blocked content cannot establish actual page content or missing markup.

The latest crawl reports no schema on 63 Atelier pages and 127 Susi pages, yet the boards claim missing structured data on 157 and 513 respectively.

Root cause: `lib/crawler/engine.ts:1096–1105` stores business-consistency “unknown” observations under the MISSING_SCHEMA issue enum. The latest crawl has 157 such observations for Atelier and 500 for Susi, caused by no accepted business knowledge revision. `lib/funnel/backfill.ts:68–104` discards issue details/message and converts every MISSING_SCHEMA into `schemaMissing: true` / `schemaType: LocalBusiness`. Unknown business verification is therefore asserted as absent markup, and all page types inherit LocalBusiness.

`latestCrawlRows` (`detectors.ts:269–276`) keeps the latest occurrence of an issue, rather than limiting the analysis to the latest crawl or recording resolution. Old defects can survive after disappearing. This is an additional reason counts can exceed latest-crawl page counts.

Confirmed false broken link: live HTML of `https://www.casamigo.net/cities/cancun` contains `${esc(url)}` inside a script template for a modal. `lib/crawler/engine.ts:268–303` scans raw HTML with an anchor regex, including script content, and interprets that template as a navigable URL. The prior assertion that this was a real site defect was wrong.

## 5. Casamigo research makes unsupported absence claims and starts from the wrong market

The O14 city-page claim is contradicted by crawled city pages. The old synthesis path selected the top 30 URLs by content score and supplied URLs only. It did not read the full relevant page content to establish absence or positioning. More representative samples help retrieval but cannot prove a semantic claim that an offer or topic is absent.

Casamigo's automatically derived topics append the office street, `Calle Juan de la Barrera`, to phrases such as `property listings` and `lead generation`. `deriveTopics` in `lib/tenants/analysis.ts:50–81` appends location to services generically. This does not identify a Riviera Maya property audience or investment journey. Its other finding treats absence of Mexico City inventory as a content opportunity without establishing that expansion belongs to the business.

The latest inspected Casamigo research run is PARTIAL with zero sources/findings. Its report records paid collection refused for lack of a USD allowance and stale collected news. The board still contains prior findings. This is not a fully researched current board.

## 6. Oceanic is not simply waiting for an upgrade

Oceanic has no keyword-metric evidence despite five research findings, and only two rank evidence rows. Its completed research snapshot records es/MX measurement although its profile/brief targets an English-speaking US audience. The current runner code attempts audience-country precedence, so the observed snapshot mismatch needs its own trace before attributing a specific current code cause.

Its recommendations infer missing coverage from candidate URLs/titles, for example that a course-choice guide does not answer how to start freediving. Without inspecting the actual guide, this is a suggestion to investigate, not a verified content gap. Adjacent scuba discussion also needs explicit relevance boundaries.

## 7. Readiness and tests do not demonstrate useful analysis

`inspectTenant` checks for configured topics, a knowledge document, a recent run and detected opportunities (`lib/tenants/analysis.ts`). It can treat a fresh PARTIAL run with no findings as research OK. It does not establish crawl coverage, extraction validity, aggregate ranking coverage, measured query intersection, correct market, source sufficiency or actionable recommendation quality.

The previously reported 859 passing tests demonstrate tested implementation behaviours, not SEO validity. The failed cross-tenant outcomes above invalidate the prior claim that the foundation was sound. A structured claim gate alone is insufficient: it cannot repair missing candidates, corrupt issue semantics or disconnected demand measurements.

## Required replan, not another tuning pass

1. Define a canonical analysis dataset: query/page performance over explicit current and comparison windows, preserved market/device scope, indexable page inventory, crawl coverage/blocked states, and exact-query provider metrics with locale and timestamps.
2. Repair extraction and typed evidence boundaries: parse real DOM links, distinguish unknown/blocked from observed defects, preserve issue identity, and explicitly resolve defects across crawls.
3. Diagnose existing performance before speculative research: enrich relevant observed queries, group by landing page and intent, compare periods, and inspect page content and SERPs. Preserve hypotheses separately from validated opportunities.
4. Rebuild prioritisation around incremental qualified traffic/value, effort and uncertainty. Do not use an arbitrary high score as evidence of an opportunity. New data must actually replace unknown score inputs.
5. Make readiness report coverage and failure states, not job completion or number of cards. Make paid collection accountable to reusable measurements and opportunities, not evidence-edge counts.
6. Validate end to end against all four tenants before expanding paid collection: reject Casamigo's false city-page premise, do not inflate schema defects from unknown knowledge, retain Susi's meaningful query/page candidates, keep Atelier's tiny-sample query provisional, and measure Oceanic in its actual audience market.

No replacement architecture is approved or implemented by this report. These are requirements for replanning and acceptance, not authorisation for a rewrite or more provider spend.

## Corrective implementation (branch `analysis-integrity`)

Implemented against this audit, with tests: see `docs/analysis-acceptance-matrix.md`.

- **Performance projection** — ranking evidence is now an explicit window aggregate
  computed in SQL (`lib/funnel/performance-window.ts`, `lib/funnel/gsc-performance.ts`),
  not the latest 400 raw rows. On live data this takes Susi from 281 ranking
  observations to 1,307 query/page pairs over 1,059 queries.
- **Detection scope** — only the current window and the current crawl are analysed,
  so a superseded month is not counted twice and a fixed defect resolves.
- **First-party demand** — O1 fires on observed impressions with a declared
  `volumeSource: first_party`; a connected site no longer needs a provider purchase to
  have query-level opportunities.
- **Prioritisation** — `lib/funnel/impact.ts` computes incremental clicks
  (`reachable impressions × (target CTR − current CTR)`) and labels each item
  `measured`, `estimated`, `technical` or `hypothesis`. The invented 120/month default
  is gone; a technical fix is ordered by severity, not by a fabricated traffic share.
- **Crawl extraction** — script/style/template/noscript regions are removed before
  link and body extraction, so the `${esc(url)}` template is no longer a broken link.
- **Issue semantics** — "business knowledge unavailable", sitemap coverage and
  crawler-block notices are no longer converted into "missing structured data".
  Susi's 513-page schema claim becomes the 127 pages that actually lack it; Atelier's
  157 becomes 63.
- **Blocked pages** — challenge and error responses produce no content-absence
  findings.
- **Research claims** — findings declare `site_claim`; a claim the crawl contradicts
  is dropped with its actions and recorded as `rejected_findings` on the run. Absence
  claims that the inventory cannot settle stay explicitly `unverified`.
- **Research targeting** — a street address is never used as a place token, and a
  tenant without declared services derives topics from observed queries instead of
  differentiators.
- **Readiness** — an empty or PARTIAL research run is no longer reported as healthy,
  and crawl coverage (cap reached) is its own step.

Still open: acquisition planning from observed performance (P4), causal claims and
comparison-window decline (P5 remainder), and migration/shadow rollout (P9).
