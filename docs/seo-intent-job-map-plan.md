# Intent and job map workstream — 2026-11-08

**Status: active workstream.** It fixes how demand is qualified. It does not change
the monthly cadence or the propose/accept model in the
[product operating model](crawlseo-product-operating-model.md). If this document
conflicts with that model on cadence or priority, the model wins. If it conflicts on
what demand means, this document wins until the model is updated.

## Why this exists

The 2026-11 run produced three demand numbers that were arithmetically correct and
semantically wrong:

- Casamigo's Tulum topic reported **534,380** monthly demand. 99.6% of it was
  `casas de cambio`, `casas de empeños` and `casas cerca de mi` — a different job,
  with zero impressions.
- Atelier's creation topic reported **50,090**, of which 49,500 was the bare
  `abat-jour` head term with zero impressions; the site ranks for the spaced variant.
- Oceanic's course topic reported **44,400**, made of world-record queries rather
  than course intent.

The review prose named the problem in all three cases. The arithmetic did not act on
it. The system measured words, not the job the searcher is trying to do.

## Principle

SEO is meeting a job the searcher is trying to do. The job is the semantic
primitive; a topic is a roll-up of one job. The technical layer measures whether the
page does the job. It never decides what the job is.

- **The model owns:** the job, its market, its language, its stage, and whether the
  business can serve it.
- **The code owns:** which queries exist, their volume, impressions, clicks and
  position, which page exists, which defect exists, and the arithmetic.
- **Context** is a query that names the market (place or brand) but not the job.
- **Noise** is a query that shares a word with the job but serves a different one.
  Neither context nor noise is demand.

A single keyword is not a job. `tulum` is a place. `casas` is a category noun.
`casas de cambio cerca de mi` is a different job that happens to share a word.

## The job map (deliverable)

One document per tenant, stored on the site profile. It is the only semantic pass:
the jobs, their markets, their owner pages and their topic fields are decided in it,
and the topic map is a projection of it.

```
Job {
  statement       buyer language: "I want to ..."
  who             audience, language
  market          scope + places
  stage           research | compare | buy | after_sale
  businessFit     serves | does_not_serve | unknown
  topic {
    name, kind, intent, relevance, coverageKind, offerKey,
    needTerms[], localIntent[], actionHint
  }
  queries[]       the tranche queries that express this job
  page            the page that does the job, or none
  reason          why the queries belong to this job
}
```

The job map also carries the site config decided in the same call: `pageTypeRules`,
`excludePaths` and `newsQueries`.

Rules:

- Every query in this cycle's tranche is assigned to one job, or explicitly marked
  `context`, `noise` or `out-of-market` with a reason. The tranche is 250 queries,
  **unjudged first**, highest impressions then volume inside that pool.
- Verdicts accumulate. A verdict is carried forward while its query is in the
  window, and the next cycle spends its tranche on queries that have never been
  judged. Only when no unjudged query remains does the cycle re-validate the
  oldest verdicts. Over cycles the whole window is covered; nothing is dropped.
- Deferred is not demand and is not "unjudged demand": it is work not yet done, and
  the report states its count, impressions and clicks. The tail shrinks each cycle.
- A job the business does not serve is not demand, however large the volume.
- The job map is written in buyer language, not SEO nouns.
- One topic is one job. The taxonomy is `projectTopicsFromJobs(jobMap.jobs)`; there
  is no second taxonomy proposal and no merge of jobs that share an owner page.

**Check:** the job map passes when every tranche query has a verdict, every job has
the complete topic contract, its page (or null) is in the supplied inventory, and
its `offerKey` is a supplied offer. The model re-proposes once with the rejected
rows named; code never fills a missing semantic field.

## Phases

### Phase 0 — stop the report from lying (done)

- "Closed" means verified fixed. A finding that was not re-proposed is
  "no longer proposed" and its row is `parked`, not closed.
- A confirmed technical finding cannot be deleted by the drafting model; it can be
  deferred with a reason.

### Phase 1 — job map pilot (done)

- Build the job map for Casamigo from business facts, offers/capacity, audience and
  a query tranche of top impressions plus top volume.
- The map separates: buy/invest in a property, check a specific project, get market
  data, and change dollars. The last is not a job the business serves.

### Phase 2 — taxonomy from jobs (done)

- The taxonomy is projected from the job map, one topic per job. Devices that
  reconciled two model outputs — `jobSlug` reconciliation, `missingJobs`, owner-page
  merging — are gone because there is no second output to reconcile.
- Need terms are the forms buyers use for that job (`casas en venta`, not `casas`),
  proposed with the job. Two jobs may share one owner page; that is the model's
  decision and code does not merge them.

### Phase 3 — carry the judgement into the arithmetic (done)

- The job map is two calls: jobs and site config in one, then verdict batches of 80
  queries against the fixed jobs, each with one retry for missing rows.
- Demand is judged demand only. Context, noise and out-of-market are shown, not
  summed. Deferred queries are counted separately and are not demand.
- Acceptance: Casamigo's Tulum demand excludes `casas de cambio`; Atelier's bare
  `abat-jour` is not demand; Susi's 914 deferred queries are reported, not counted.

### Phase 4 — board on qualified demand (done)

- Score and gate read qualified demand only. The gate uses site-level Search Console
  totals, not the sum of topic memberships, because memberships overlap and miss
  queries. Expected clicks start from measured impressions; market volume is shown
  beside the estimate, never multiplied into it.
- Among scored proposals, a money page (a service, product or buyer job) comes
  before a content page even when the content page has more projected clicks: a
  buyer page at 10 clicks is worth more than an informational page at 24. A
  content-led business marks its core work as a business proposal to enter the
  money track; no tenant branch is needed.
- Technical findings are ordered by severity and reach, and stay separate from
  content proposals.
- The board stores what the model drafted. Code does not merge, group or re-target
  proposals; the critique is advice carried on the row.

### Phase 5 — re-run and compare (done)

- The four tenants ran on the one-pass pipeline. Before/after: qualified demand,
  jobs covered, deferred count, top five per board.
- The existing maps and boards stay as the baseline.

## Guardrails

- No stoplists of tenant phrases, no per-tenant branches in `lib/`.
- No code-side inference of intent from words.
- No code reconciliation between model outputs: no merging topics by owner page, no
  filling a missing semantic field, no deriving need terms from query tokens.
- No new ledger or schema until the logic is stable.
- Do not change the monthly cadence or the opportunity acceptance gate.

## Current step

The one-pass pipeline is in place and has run on all four tenants. The job map
decides the jobs, markets, pages and topic fields; the taxonomy is projected from
it; the topic map is built from judged demand; and the boards are re-drafted.

| Tenant | Jobs | Judged | Demand | Clustered | Deferred | Not demand |
|---|---:|---:|---:|---:|---:|---:|
| Casamigo | 14 | 274/274 | 21 | 21 | 0 | 253 |
| Atelier | 13 | 169/169 | 116 | 116 | 0 | 53 |
| Susi | 24 | 500/1164 | 404 | 404 | 664 | 96 |
| Oceanic | 13 | 85/85 | 42 | 42 | 0 | 43 |

Susi is the first tenant whose query set exceeds one tranche. Its second cycle judged
the next 250 unjudged queries and carried the first 250: judged 500, demand 404,
deferred 664. Two more cycles cover the rest, after which the oldest verdicts are
re-validated. The earlier Susi runs failed on truncated JSON because jobs and verdicts
shared one response; splitting the verdicts into batches removed the failure, not a
cap.

Boards: Casamigo 17 proposals, Atelier 17, Susi 28, Oceanic 13. Casamigo remains
foundations-first at 39 impressions. Rows that were not re-proposed are reported as
"no longer proposed" and parked, never closed. A re-proposal of a verified closure
is reported for regression checking, not reopened silently.

## Definition of done

Every tenant's demand number is the sum of queries the model judged as demand for a job
the business serves; context, noise and out-of-market queries are visible but excluded;
queries outside the tranche are reported as deferred, never counted; the board's top
five rest only on qualified demand; and the job map that produced it passed its checks.

## Out of scope

- A new scoring model or winnability factor.
- A page-level ledger.
- Changes to cadence, proposal lanes or the acceptance model.
