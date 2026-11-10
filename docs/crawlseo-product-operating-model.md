# CrawlSEO product operating model

**Status: authoritative product requirements — 2026-11-05.**

This is the one-page model. The execution plan is
[`crawlseo-simplified-execution-plan.md`](crawlseo-simplified-execution-plan.md).
Historical documents are in [`archive/`](archive/README.md); they are not
requirements.

## What CrawlSEO is

A self-hosted, multi-tenant SEO operating system.

For every active site it must understand the business, collect the relevant
evidence, **propose** article ideas, business opportunities, AEO/GEO gaps and
technical work, let a human accept what is worth doing, turn accepted work into a
task, and measure the outcome.

**The system proposes. The human accepts. Nothing is published automatically.**

## Cadence

| Cadence | Runs | Produces |
|---|---|---|
| **Weekly** | Crawl, GSC/GA4 refresh, opportunity refresh, business-update research sweep | Technical/content changes and timely ideas |
| **Monthly** | One DataForSEO bundle per site: keyword, SERP, AEO/GEO; deep research synthesis | Article ideas, business opportunities, AEO/GEO opportunities |
| **Event-driven** | New-site bootstrap, accepted-work follow-up, action-triggered AEO re-ask | Targeted updates without a full monthly pull |

A site gets **one** DataForSEO bundle per month. It is stored and reused. Weekly
work does not call DataForSEO.

## Research tracks

1. **Business and site** — offers, audience, markets, competitors, pages, content,
   internal links, technical health.
2. **First-party demand** — GSC/GA4 queries, pages, impressions, clicks, position,
   conversions.
3. **DataForSEO demand** — keyword overview/related/suggestions, SERP snapshots,
   Google AI Overviews and agreed AI surfaces. Monthly.
4. **Business updates** — exhibitions, market/regulation news, competitions, local
   events, competitor launches. Weekly, with source and date.
5. **AEO/GEO** — measured DataForSEO observations, not question coverage.

## What the system proposes

### Opportunities

A specific action with evidence:

- title and one-line summary;
- lane: Timely, Content & business, AEO/GEO, Technical;
- why it exists and why now;
- evidence and source dates;
- affected offer/page/audience;
- target page/section or new asset;
- specific action;
- expected outcome;
- effort and confidence;
- expiry/re-check date for timely items.

### Article ideas

A first-class proposal, not a by-product:

- target query/topic;
- volume where measured, or “unmeasured”;
- intent and audience;
- existing coverage and what is missing;
- proposed angle/title;
- new article, update, or cluster hub;
- supporting evidence;
- effort and success measure.

### Technical work

A separate lane. It names the page, issue, fix, evidence and expected effect. It
does not crowd out content, business or AEO/GEO.

### Investigations

Only when a genuine owner/private/expert question remains after the machine has
read the available evidence. An investigation is a proposal state, not a fifth
pipeline.

## Board lanes

| Lane | Contents |
|---|---|
| **Timely** | Events, news, regulation, competitions, market changes; has `whyNow` and expiry |
| **Content & business** | Article ideas, updates, cluster hubs, service/positioning gaps |
| **AEO/GEO** | Measured AI Overviews / AI-surface presence and citation gaps |
| **Technical** | Crawl, schema, canonical, performance, broken links |

A single score may order items inside a lane. It must not bury Timely, Content &
business or AEO/GEO under technical hygiene.

## Human workflow

```
proposed → accepted → task → agent-prepared → human-confirmed → delivered → measured
```

- The system creates proposals.
- The human accepts, parks or rejects.
- Only acceptance creates a task.
- Agent preparation is optional and never publishes.
- Human confirms delivery once. After that confirmation the agent performs the
  mechanical steps (create the embed, write the content, publish the article)
  without asking for a second click. A new Wix page is the one manual step: Wix
  has no page-creation API, so the human creates the blank page at the route the
  task names, and the worker resumes delivery when it answers.
- Outcome is measured and feeds the next cycle.

## Cost and storage

- One DataForSEO bundle per site per month, idempotent.
- Raw payloads, normalized evidence, costs and receipts are stored.
- Weekly research uses bounded, cheap sources; no DataForSEO.
- AEO/GEO is part of the monthly bundle.
- Every paid run has a cap and a receipt.
- Failed/partial runs are recorded, not silently retried at full cost.

## Definition of done

For an active site:

1. The weekly cycle crawls, refreshes first-party evidence, updates the board and
   runs a business-update research sweep.
2. A real event/news/regulation produces a sourced timely proposal with `whyNow`
   and an expiry.
3. The monthly DataForSEO bundle runs once, is stored and reused.
4. Keyword/SERP evidence produces specific article ideas with targets and evidence.
5. AEO/GEO proposals come from measured DataForSEO observations.
6. The board shows Timely, Content & business, AEO/GEO and Technical lanes.
7. A human accepts a proposal and gets a task with a brief, target and success
   measure.
8. Accepted work is measured.
9. No quota, no fabricated opportunities, no keyword-volume gate, no duplicate
   DataForSEO charge.

## Anti-patterns

- a board dominated by technical hygiene;
- five DataForSEO pulls a month for the same site;
- generic news summaries with no business action;
- question coverage presented as measured AEO visibility;
- article ideas that are rephrased old recommendations;
- automatic acceptance, or publication and delivery without a human
  confirmation;
- manufacturing ideas to fill a quota;
- a single score that hides business ideas below technical fixes;
- paid retries that duplicate a stored monthly bundle.

## Authority

This model is authoritative for product behaviour. If another document conflicts
on cadence, proposal flow, board priority or AEO/GEO source, this model wins.
The detailed how-to is in the execution plan; engineering history is in the
archive.
