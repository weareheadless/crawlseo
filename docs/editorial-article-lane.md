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

## Pictures

The writer chooses a cover and inline pictures and stores them on the draft's
`assets` column, with `id`, `role`, `url`, `width`, `height`, `alt`, `credit`
and `credit_url`. The body carries `<!-- image: img_2 -->` on its own line under
the heading the picture belongs to. Nothing about the picture is Wix-specific,
so Payload can upload the same URLs and place them at the same markers.

The Wix delivery imports each asset into Wix media and inserts a Ricos `IMAGE`
node at the marker, followed by the Unsplash credit as a linked paragraph. A
picture that cannot be imported is skipped with a warning; it never blocks a
publish. The planned cover is used as the hero instead of searching Unsplash a
second time.

## Wix rich text

`markdownToRicos` is the single conversion point:

- headings `#`–`######`, with the leading H1 dropped when it repeats the title
  and any remaining H1 rendered as an H2 below the page title;
- paragraphs and bulleted lists with 18px paragraph spacing and 24/8px heading
  spacing;
- `**bold**` and `[text](url)` links, so `/devis` is a link and not literal
  markdown;
- image markers and their credit, as above.

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
- Content Studio is gone, including its API: `/api/sites/:id/content-studio/drafts`,
  `/api/content-drafts/*`, `/api/sites/:id/content-drafts/*` and the
  `/api/actions/:id/draft` + `wix-blog-draft` buttons it drove. A draft is now
  created by the lane that owns it — the article reconciler above, or the page
  lane.
