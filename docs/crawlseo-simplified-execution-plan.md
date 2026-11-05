# CrawlSEO simplified execution plan — 2026-11-05

**Status: active execution plan.** The goal is unchanged. The approach is simpler:
collect the data, reduce it into SEO-sized layers, let the AI make the judgements,
validate only what code must validate, and show the proposals to a human.

The product model is
[`crawlseo-product-operating-model.md`](crawlseo-product-operating-model.md).
Historical plans are in [`archive/`](archive/README.md).

## Goal

For every active site:

- understand the business, site, demand and timing;
- collect keyword, SERP, AEO/GEO, GSC, crawl, news and event evidence;
- **propose** article ideas, business opportunities, AEO/GEO gaps and technical work;
- let a human accept what is worth doing;
- turn accepted work into a task and measure the outcome.

The system proposes. The human accepts. Nothing is published automatically.

## How an SEO expert would approach it

1. **Business** — offers, audience, markets, competitors, constraints.
2. **Site** — pages, services, locations, content, links, technical health.
3. **Demand** — topics, intents, volume, SERP, GSC, AI citations.
4. **Timing** — exhibitions, market/regulation news, competitions, local events,
   competitor launches.
5. **Topic map** — cluster demand and pages by intent and business relevance.
6. **Coverage** — does the site answer the cluster fully, partially, or not at all?
7. **Opportunity** — update, article, cluster hub, AEO/GEO action, technical fix, or
   no action.
8. **Challenge** — is the evidence real? Is the page actually missing? Is this
   cannibalisation? Is the action specific? Is the timing real?
9. **Rank and present** — business value, confidence, effort, urgency; separate lanes.
10. **Human accepts** — then task, delivery, measurement.

Layering is data reduction, not approval gates. The AI makes the SEO judgement; code
checks scope, evidence, cost and human acceptance.

## Data layers

| Layer | Contents |
|---|---|
| **L0 raw** | DataForSEO payloads, GSC, crawl, news/events, AI answers |
| **L1 normalized** | Keywords, SERP results, pages, GSC rows, crawl issues, news items, AI observations |
| **L2 clusters** | Topic/intent clusters, page groups, competitor set, event/news items |
| **L3 evidence pack** | One cluster's keywords, SERP top results, our pages, GSC metrics, business facts, news, citations |
| **L4 AI proposals** | Candidate opportunities with evidence refs and specific actions |
| **L5 board** | Validated, deduplicated proposals in lanes |
| **L6 work** | Accepted tasks, briefs, delivery, outcome |

## AI calls

Multiple calls are expected. Each has one job.

| Call | Input | Output | Cadence |
|---|---|---|---|
| **A. Context synthesis** | Business, site, page inventory, competitors, market | Topic map and clusters | Monthly, one per site |
| **B. Cluster analysis** | One cluster's evidence pack | Opportunity or no-action, lane, missing coverage | Monthly, per cluster/batch |
| **C. Article/business drafting** | Selected cluster + evidence | Specific angle, target, action, success measure | Monthly, per selected cluster |
| **D. Timely research** | News/events/regulations/competitions + business context | Timely proposals with `whyNow` and expiry | Weekly, per site/batch |
| **E. AEO/GEO analysis** | Question set, measured AI answers/citations, our pages | Presence/citation gaps and actions | Monthly, per question batch |
| **F. Critique/QA** | Batch of proposals + evidence refs | Unsupported claims, duplicates, cannibalisation, wrong targets | After drafting |
| **G. Weekly triage** | Changed crawl/GSC/news | New or changed proposals only | Weekly, per site |

## Minimal opportunity contract

```ts
{
  siteId: string;
  lane: "timely" | "content_business" | "aeo_geo" | "technical";
  kind: "article" | "update" | "cluster_hub" | "business" | "aeo" | "technical";
  title: string;
  summary: string;
  whyNow: string | null;
  evidenceRefs: string[];
  target: { url: string | null; newAsset: boolean; section: string | null };
  action: string;
  expectedOutcome: string;
  effort: "small" | "medium" | "large" | "unknown";
  confidence: "high" | "medium" | "low";
  expiresAt: string | null;
}
```

Code validates required fields, evidence ownership, site-scoped targets, expiry,
duplicate keys and per-call limits. It does not decide whether the idea is good.

## Phases

### Phase 0 — freeze and pilot (1 day)

- Pick one pilot: Atelier or Susi.
- Confirm bundle contents and caps.
- Reuse `EvidenceRecord`, `Opportunity`, `Task`.
- No new pipeline or recommendation table.

**Exit:** one site, one bundle definition, one lane design.

### Phase 1 — monthly bundle and storage (2–3 days)

- DataForSEO keyword/SERP/AEO-GEO, GSC, crawl, news/events, business knowledge.
- Store raw payloads and normalized evidence.
- Idempotent key `monthly:<siteId>:<YYYY-MM>:bundle`.
- Record cost and status.

**Exit:** one real bundle stored; rerun does not pay twice.

### Phase 2 — topic map and clusters (2 days)

- Group keywords by topic/intent.
- Map clusters to existing pages.
- AI call A for context synthesis.
- Store clusters and coverage.

**Exit:** readable topic map with business relevance and coverage.

### Phase 3 — opportunity generation (3–4 days)

- Calls B, C, D, E.
- Store proposals with the minimal contract.
- Call F for critique.
- Fix prompt/data, not schema.

**Exit:** board with specific article, business, AEO/GEO and technical proposals,
each with evidence refs.

### Phase 4 — board and human acceptance (2–3 days)

- Four lanes.
- Evidence, target, action, why now, expiry.
- Accept → task with brief; park/reject.

**Exit:** human can accept and get a task; no automatic execution.

### Phase 5 — weekly refresh and timely research (2–3 days)

- Weekly crawl/GSC.
- Weekly news/event sweep.
- Re-run affected clusters and triage.
- Expire timely items.

**Exit:** a real timely proposal with source and expiry when an event/news item exists.

### Phase 6 — pilot evaluation and rollout (3–5 days)

- Review the actual board with the owner.
- Judge specificity, relevance, evidence and usefulness.
- Fix prompt/data.
- Roll to the other pilot sites.
- Keep one DataForSEO bundle per site per month.

**Exit:** real proposals reviewed, accepted work created, outcomes measurable.

## Operating rules

- **Weekly:** crawl, GSC/GA4, opportunity refresh, business-update research.
- **Monthly:** one DataForSEO bundle per site; store and reuse.
- **System proposes; human accepts.** Only acceptance creates a task.
- **Lanes:** Timely, Content & business, AEO/GEO, Technical.
- **AEO/GEO** comes from measured DataForSEO observations, not question coverage.
- **No quota, no fabricated evidence, no keyword-volume gate, no weekly DataForSEO
  spend.**

## What not to build

Do not add:

- a new packet builder or inventory pagination layer;
- a 13-field decision schema or repair loop;
- per-candidate ledgers, fairness cursors or dependency manifests;
- shadow comparison and rollback as a gate to the first useful board;
- a scoring model that hides business ideas under technical rows;
- more legacy detectors before the thin slice works.

Keep and reuse:

- `EvidenceRecord` and evidence storage;
- `Opportunity` and `Task`;
- the human acceptance gate;
- cost caps and idempotency;
- tenant/project scope;
- audit and provenance.

## Acceptance

The first slice is done when, for one pilot site:

1. one monthly bundle is collected and stored;
2. a topic map exists;
3. the AI produces specific article, business, AEO/GEO and technical proposals;
4. every proposal has evidence refs and a target;
5. the board separates the four lanes;
6. a human accepts a proposal and gets a task;
7. a weekly news/event sweep produces a timely proposal with `whyNow` and expiry;
8. no DataForSEO duplicate charge;
9. no fabricated evidence or auto-published work.

Then repeat for the other pilot sites. Only after that discuss shadow, rollback,
advanced scoring or broader rollout.
