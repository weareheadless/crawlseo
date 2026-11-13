# Editorial article lane

New blog articles are written by the editorial service. Everything else stays
in CrawlSEO: the opportunity, the approval, the Wix Blog draft and the delivery
receipt.

## The chain

```
accepted Opportunity
  → canonical Task
  → prepareOpportunityWithAgent
  → ResearchAction (opportunity:<id>)
  → AgentTask kind=wix_article, status=RUNNING
  → Job kind=EDITORIAL_ARTICLE
  → editorial post (queued … ready)
  → ContentDraft + AgentTask AWAITING_REVIEW
  → human approves
  → Wix Blog draft → publish → Delivery receipt
```

The lane is chosen by the recommendation target, not by the opportunity type:
a `/post/…` or `/blog/…` URL is an article. A new asset takes the page lane.

## What CrawlSEO sends

`lib/editorial-service/brief.ts` builds the brief. Editorial never reads this
database, so the brief is the whole input:

- `tenant` — the site's `SiteDeliveryConfig.bridgeAlias`, which is also the
  editorial token's tenant.
- `evidence.source_urls` — up to four pages from the latest completed crawl,
  ranked by the query in their title and URL, with boilerplate and thin pages
  dropped. Editorial fetches them and records what it read, so the evidence is
  auditable on both sides.
- `topic` — the primary query as the question, the action recommendation as the
  angle.
- `policy` — `approval: none`, `publish: false`, `on_unverified: hold`. CrawlSEO
  is the only place that can approve or publish.
- `idempotency_key` — `crawlseo:action:<id>:rev:<revision>`, so a duplicate
  prepare returns the same editorial post.

## What CrawlSEO reads back

`lib/editorial-service/article-task.ts` reconciles a running task:

| Editorial state | AgentTask |
|---|---|
| `queued` … `verifying` | stays `RUNNING`; the job is deferred, not retried |
| `ready` / `published` | `AWAITING_REVIEW`, artifact stored as a `ContentDraft` (`provider: editorial`) |
| `held` | `FAILED`, code `EDITORIAL_HELD`; no draft, because there is nothing verified to approve |
| `failed` / `cancelled` | `FAILED`, code `EDITORIAL_FAILED` / `EDITORIAL_CANCELLED` |

The job is deferred with `EDITORIAL_STILL_WRITING` while editorial works, so
polling never spends an attempt. A terminal failure reopens the same task on the
next prepare and asks editorial for a fresh post.

The artifact hash is stored in the draft's `brief.editorial.content_hash` and in
the task result. Re-reconciling the same post does not create a second draft.

## Configuration

```bash
EDITORIAL_URL=http://127.0.0.1:8790
EDITORIAL_TOKEN=...
# Optional; defaults to the tenant prefix (atelier-harmonie -> atelier)
EDITORIAL_VOICE=
```

With no URL or token, `editorialEnabled()` is false and the article lane keeps
the previous in-app writer. That makes this switch safe to deploy before the
service is reachable from the worker.

## Not in this slice

- Existing blog post updates still use the synchronous writer, which needs the
  post's current body.
- `ResearchAction`, `ContentDraft` and `Delivery` stay: the article lane still
  stores its artifact and receipt there.
- The Content Studio UI and its API routes are still present, unlinked. They are
  removed in the data-retirement slice.
