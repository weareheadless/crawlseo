# CrawlSEO product operating model

**Status: authoritative product requirements — 2026-11-05.**

This document is the single source of truth for what CrawlSEO is supposed to
provide, how often each part runs, and who triggers work. It supersedes
conflicting cadence, priority or proposal statements in earlier plans. Earlier
documents remain historical records; where they disagree with this document,
this document wins.

## At a glance

| Question | Answer |
|---|---|
| What runs weekly? | Crawl, first-party evidence, opportunity refresh, business-update research sweep |
| What runs monthly? | One DataForSEO bundle per site: keyword, SERP, AEO/GEO |
| Who proposes? | The system proposes opportunities, article ideas and technical work |
| Who triggers? | The human accepts; only then is a task created |
| Where do proposals go? | Timely, Content & business, AEO/GEO, Technical lanes |
| Where does AEO/GEO come from? | Measured DataForSEO observations, not question coverage |
| How often is DataForSEO paid? | Once per site per month, stored and reused |
| Is there a quota? | No. No fabricated ideas, no keyword-volume gate |

## 1. What CrawlSEO is

CrawlSEO is a self-hosted, multi-tenant SEO operating system.

For every active tenant it must:

1. understand the business, its offers, audience, markets and website;
2. collect the evidence needed to find demand, content, business, AEO/GEO and
   technical opportunities;
3. **propose** specific opportunities, article ideas and technical work;
4. investigate the evidence it can obtain itself before asking a person;
5. let a human accept, park or reject each proposal;
6. turn accepted proposals into tasks, with a brief, target and success measure;
7. measure the outcome and feed it into the next cycle.

The system proposes. The human triggers the work. Nothing is published,
executed or spent outside the approved monthly collection bundle without a human
accepting it.

## 2. Non-negotiable model

- **The system proposes opportunities, article ideas and technical work.** A
  board that only shows technical hygiene is a failure of the product.
- **The human accepts the work.** Acceptance is the only path that creates a
  task. Agent preparation can happen after acceptance; publication and delivery
  remain human-confirmed.
- **No positive-output quota.** The system must not manufacture ideas to fill the
  board. An honest no-action or blocked result is valid.
- **No keyword-volume gate.** Volume is evidence, not permission. A relevant
  business idea with unmeasured demand can still be proposed, clearly marked
  unmeasured.
- **Evidence before assertion.** Every proposal cites the evidence it used, the
  page or offer it affects, and what remains unknown.
- **One research bundle, stored once.** DataForSEO is paid for once per tenant per
  month, persisted, and reused. It is not pulled five times a month.
- **No automatic execution.** The system does not publish, edit the site, or
  accept its own proposals.

## 3. Cadence

| Cadence | Runs | Produces |
|---|---|---|
| **Weekly** | Crawl the site, refresh first-party evidence (GSC/GA4/crawl), re-run opportunity detection, refresh the board, run a lightweight business-update research sweep | Technical/content changes, refreshed rankings/coverage, and **timely** business ideas |
| **Monthly** | One DataForSEO bundle per tenant: keyword data, SERP snapshots, AEO/GEO visibility; deep research synthesis; article-idea generation | Stable demand layer, article ideas, AEO/GEO opportunities, monthly board review |
| **Event-driven** | New-site bootstrap, action-triggered re-ask, manual refresh, accepted-work follow-up | Targeted updates without paying for a full monthly pull |

A tenant is one active site being analysed. A project with multiple active sites
gets one bundle per site, because the domain, locale and demand data differ.

## 4. Research tracks

### 4.1 Site and content evidence (weekly)

Crawl the site, read the relevant pages, record what was read, what was blocked,
what was truncated and what is unknown. This feeds technical and content
opportunities and prevents “we did not read it” from becoming “the page is
missing”.

### 4.2 First-party demand (weekly)

Search Console and GA4 observations: queries, pages, impressions, clicks,
position, conversions. These are the site's own demand signals and the baseline
for measuring outcomes.

### 4.3 DataForSEO demand (monthly)

One bundle per site per month:

- keyword overview, related keywords and suggestions;
- SERP snapshots for the selected queries;
- Google AI Overviews / AEO-GEO observations;
- optional backlinks or other DataForSEO products only when explicitly included
  in the bundle.

Store raw provider payloads, normalized evidence, provenance, cost and the run
receipt. Reuse the stored result for the rest of the month. Do not call
DataForSEO again for the same bundle.

### 4.4 Business-update research (weekly sweep, monthly synthesis)

This is the layer that was missing. It looks for **what changed around this
specific business**, not generic market news.

Sources include:

- news and local press;
- trade and industry publications;
- event and exhibition calendars;
- government/regulatory publications;
- competitor sites and launches;
- federations, associations and competition calendars;
- relevant community/social sources where authorised.

Examples:

- **Atelier** — an exhibition, craft fair, heritage event, interior-design show or
  local Normandy event. Proposal: create an event page, a workshop offer or a
  timely article; target page and expiry included.
- **Susi / Casamigo** — Riviera Maya, Tulum or Playa del Carmen real-estate news,
  regulation, foreign-buyer rules, infrastructure, tourism, interest rates or new
  developments. Proposal: update the ownership guide, publish a dated market
  explainer or add a city page; why-now and expiry included.
- **Oceanic** — freediving competitions, federation standards, safety guidance,
  certification changes, marine/travel news. Proposal: create an event/training
  page or update the course/safety page; why-now and expiry included.

Every update finding must answer:

1. What changed?
2. What is the source and date?
3. Why does it matter to this business?
4. Which offer, page or audience does it affect?
5. What specific action should follow?
6. When does it expire or need re-checking?
7. How confident are we, and what evidence supports it?

Only findings with a specific action and evidence become opportunities. The rest
remain research notes.

### 4.5 AEO/GEO (monthly, from DataForSEO)

AEO/GEO is part of the monthly DataForSEO bundle, not a separate weekly paid
product.

- Measure Google AI Overviews and the agreed AI surfaces through DataForSEO.
- Store the exact question, surface, locale, answer, citations, brand presence,
  asked-at time and run receipt.
- O4/O5 opportunities come from **measured observations**, not from question
  coverage.
- Question coverage without a measured answer is “unobserved”, not an AEO
  opportunity.
- A failed request is not an observation; absence is not zero mentions.
- Event/action-triggered re-asks are separate, capped and linked to the action
  that caused them.

## 5. What the system proposes

### 5.1 Opportunities

A proposal with a specific business or content action. Examples:

- “Create an article answering X; competitors cover it and we do not.”
- “Update the fideicomiso guide because the regulation changed.”
- “Create an exhibition page for Atelier before the March event.”
- “Add a training page for the freediving competition in June.”
- “Fix the missing canonical on these pages.”

Each opportunity carries:

- title and one-line summary;
- lane: Timely, Content & business, AEO/GEO, or Technical;
- why it exists and why now;
- evidence and source dates;
- affected offer/page/audience;
- specific action and target page/section or new asset;
- expected benefit mechanism;
- effort and confidence;
- risks, reviews and uncertainty;
- success measure;
- expiry/re-check date for timely items;
- readiness: actionable, investigation, no-action or rejected.

### 5.2 Article ideas

Article ideas are a first-class proposal type, not a by-product of technical
detection. They include:

- target query or topic;
- measured volume where available, or “unmeasured”;
- intent and audience;
- existing coverage and what is missing;
- proposed angle/title;
- target page (new article, update, or cluster hub);
- supporting SERP/keyword/business evidence;
- why now, if timely;
- effort and success measure.

### 5.3 Technical work

Technical defects remain proposals, but they get their own lane. They must name
the page, the issue, the fix, the evidence and the expected effect. They must not
crowd out content, business or AEO/GEO proposals.

### 5.4 Investigations

An investigation is a proposal state, not a fifth pipeline. It is used only when
a genuine owner/private/expert question remains after the machine has read the
available evidence. It must state what was checked, what is missing, who can
answer it, the decision criteria and the deliverable.

## 6. Board lanes

The board must separate:

| Lane | Contents |
|---|---|
| **Timely** | Events, news, regulation, competitions, market changes; has `whyNow` and `expiresAt` |
| **Content & business** | Evergreen article ideas, service/offer gaps, positioning opportunities |
| **AEO/GEO** | Measured AI Overviews / AI-surface presence and citation gaps |
| **Technical** | Crawl, schema, canonical, performance, broken links, etc. |

A single score may order items inside a lane. It must not bury Timely, Content &
business or AEO/GEO under technical hygiene.

## 7. Human workflow

```
proposed → accepted → task → agent-prepared → human-confirmed → delivered → measured
```

- **Proposed:** system creates the opportunity with evidence.
- **Accepted:** human accepts; only then is a task created.
- **Task:** carries the decision snapshot, target, action and success measure.
- **Agent-prepared:** optional draft/preparation; never published automatically.
- **Human-confirmed:** a person confirms delivery.
- **Delivered:** recorded with receipt.
- **Measured:** outcome compared with baseline; feeds the next cycle.

Parking, rejecting and re-opening are human decisions. A changed premise is shown
as a review warning; it does not silently rewrite accepted work.

## 8. Cost and storage

- One DataForSEO bundle per site per month, idempotent key
  `monthly:<siteId>:<YYYY-MM>:dataforseo`.
- Store raw payloads, normalized evidence, costs and receipts in the database.
- Reuse stored results; do not re-buy the same data.
- Weekly business-update research uses bounded, cheap sources. It does not call
  DataForSEO.
- AEO/GEO is part of the monthly bundle. Event-triggered re-asks are capped.
- A failed or partial run is recorded; it is not silently retried at full cost.
- Every paid run has a cap and a recorded spend.

## 9. Definition of done

The product is working when, for an active tenant:

1. The weekly cycle crawls, refreshes first-party evidence, updates the board and
   runs a business-update research sweep.
2. The weekly sweep produces at least one sourced, timely proposal when a real
   event/news/regulation exists — with `whyNow` and an expiry.
3. The monthly DataForSEO bundle runs exactly once, is stored, and is reused.
4. Keyword/SERP evidence produces specific article ideas with targets and
   evidence.
5. AEO/GEO proposals come from measured DataForSEO observations, not question
   coverage.
6. The board shows Timely, Content & business, AEO/GEO and Technical lanes; a
   technical score does not hide the other lanes.
7. A human can accept a proposal and get a task with a brief, target and success
   measure; nothing is executed or published automatically.
8. Accepted work is measured and the result is visible in the next cycle.
9. No quota, no fabricated opportunities, no keyword-volume gate, no repeated
   DataForSEO charge.

## 10. Anti-patterns

These are explicitly not the product:

- a board dominated by “missing structured data” and other technical hygiene;
- five DataForSEO pulls a month for the same tenant;
- generic news summaries with no business action;
- question coverage presented as measured AEO visibility;
- article ideas that are only rephrased old recommendations;
- automatic acceptance, publication or delivery;
- manufacturing ideas to fill a quota;
- a single score that hides business ideas below technical fixes;
- paid retries that duplicate a stored monthly bundle.

## 11. Current state and gaps (2026-11-05)

| Area | State |
|---|---|
| Weekly crawl and opportunity refresh | Exists |
| First-party GSC/GA4/crawl evidence | Exists |
| Recommendation decision, acceptance, tasks, shadow/rollback | Engineering implemented |
| Weekly business-update research sweep | **Missing** |
| Monthly DataForSEO keyword/SERP bundle | **Manual or missing; not in the monthly cycle** |
| Keyword/SERP → article ideas | **Incomplete; O3 only reads `serp_snapshot`** |
| AEO/GEO from measured DataForSEO observations | **Disconnected from O4/O5; question coverage is used instead** |
| Timely lane with `whyNow`/expiry | **Missing** |
| Board lanes that prevent technical dominance | **Missing** |
| Package 6 fresh monthly discovery evaluation | **Not done** |

Current board evidence: O7 technical defects and O8 structured-data gaps have the
highest scores; O13/O14 business ideas score around 3 and are buried. The DataForSEO
AEO observations from 28 October are stored in `AIVisibilityObservation`, while the
O4/O5 detectors read `EvidenceRecord`, so the board does not see them.

## 12. Authority and related documents

This document is authoritative for product behaviour. Read it before the older
plans.

Related documents:

- [`seo-funnel-spine-plan.md`](seo-funnel-spine-plan.md) — code-referenced funnel
  entities, detectors and evidence kinds; historical architecture reference.
- [`aeo-geo-evaluation-plan.md`](archive/aeo-geo-evaluation-plan.md) — historical
  AEO/GEO work packages; the contracts in `docs/aeo-*.md` remain active.
- [`pipeline-implementation-plan.md`](archive/pipeline-implementation-plan.md) —
  historical Business → Research → Findings → Work → Results navigation plan.
- [`structural-recommendation-handoff-2026-11-04.md`](archive/structural-recommendation-handoff-2026-11-04.md)
  — engineering state and release handoff.
- [`recommendation-migration-completion-review-2026-11-04.md`](archive/recommendation-migration-completion-review-2026-11-04.md)
  — engineering review; not a product acceptance document.

Where an older document says weekly AEO/GEO paid runs, five DataForSEO pulls a
month, technical-only prioritisation, or automatic execution, this document
supersedes it.
