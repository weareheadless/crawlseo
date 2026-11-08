# Intent and job map workstream — 2026-11-07

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

One document per tenant, stored next to the taxonomy and versioned with it.

```
Job {
  statement       buyer language: "I want to ..."
  who             audience, language
  market          places / audience market
  stage           research | compare | buy | after-sale
  queries[]       the measured queries that express this job
  page            the page that does the job, or none
  businessFit     serves | does not serve | unknown
  reason          why the queries belong to this job
}
```

Rules:

- Every measured query with volume is assigned to one job, or explicitly marked
  `context`, `noise` or `out-of-market` with a reason.
- No silent drop: the document reports how many queries were assigned and how many
  were not.
- A job the business does not serve is not demand, however large the volume.
- The job map is written in buyer language, not SEO nouns.

**Gate:** a human accepts the job map before any taxonomy is proposed. This is the
step that keeps the work anchored to the business rather than the query export.

## Phases

### Phase 0 — stop the report from lying (independent)

- "Closed" means verified fixed. A finding that was not re-proposed is
  "superseded", not closed.
- A confirmed technical finding cannot be deleted by the drafting model; it can be
  deferred with a reason.
- Acceptance: Susi's 59-page duplicate-title finding is visible and not called
  closed; every confirmed crawl defect appears in the technical lane.

### Phase 1 — job map pilot (Casamigo)

- Build the job map for Casamigo from business facts, offers/capacity, audience and
  a query sample of top impressions **plus** top volume.
- The map must separate: buy/invest in a property, check a specific project, get
  market data, and change dollars. The last is not a job the business serves.
- Acceptance: the map reads like buyer language; every query with volume is
  assigned or explicitly marked; a human accepts it.

### Phase 2 — taxonomy from jobs

- Re-propose with the accepted job map as the base. One topic is one job. A topic
  that aggregates two jobs is a contract rejection, not a `mixed` label.
- Need terms are the forms buyers use for that job (`casas en venta`, not `casas`).
- Acceptance: no topic contains queries from two jobs; the Tulum topic excludes
  `casas de cambio`; Atelier separates restore, buy and learn.

### Phase 3 — carry the judgement into the arithmetic

- The review receives a query sample of top impressions and top volume, with the
  omitted count.
- The review returns a demand verdict per query: `demand`, `context` or `noise`,
  alongside the existing `inMarket` verdict.
- Demand is the sum of qualified queries only. Context and noise are shown, not
  summed. Unjudged queries stay in demand and are counted as unjudged.
- Acceptance: Tulum demand is about 2.3k with 532k noise displayed; Atelier's bare
  `abat-jour` is out of demand; nothing is dropped silently.

### Phase 4 — board on qualified demand

- Score and gate read qualified demand only. Market-only volume is shown next to it,
  never inside it.
- Technical findings are ordered by severity and reach.
- Two proposals on the same job or page are flagged as possible cannibalisation.
- Acceptance: every top-five proposal rests on qualified demand, and the technical
  order matches the stated rule.

### Phase 5 — re-run and compare

- Re-run the four tenants. Before/after: qualified demand, jobs covered, top five
  per board.
- One short memo per tenant. The existing maps and boards stay as the baseline.

## Guardrails

- No stoplists of tenant phrases, no per-tenant branches in `lib/`.
- No code-side inference of intent from words.
- No taxonomy re-proposal before the job map is accepted.
- No new ledger or schema until phases 0–3 are done.
- Do not change the monthly cadence or the human acceptance gate.

## Current step

Build the Casamigo job map. Review it with the owner. If the format reads like buyer
language, generalize it to the other three tenants and then change the pipeline. If
it does not, fix the format before touching code.

## Definition of done

Every tenant's demand number is the sum of queries that carry both the market and the
job; context and noise are visible but excluded; the board's top five rest only on
qualified demand; and a human has accepted the job map that produced it.

## Out of scope

- A new scoring model or winnability factor.
- A page-level ledger.
- Changes to cadence, proposal lanes or the acceptance model.
