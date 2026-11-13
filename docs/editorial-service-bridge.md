# Editorial service bridge

CrawlSEO proposes an article; the shared editorial service writes and verifies
it; CrawlSEO keeps ownership of the review and the Wix delivery. Editorial never
publishes in this flow and never reads this database.

```
ResearchAction (accepted or proposed, format=article)
  → evidence bundle from the latest crawl (AuditPage.contentText)
  → POST editorial /v1/posts   policy.publish=false, approval=owner
  → poll GET /v1/posts/{id}    ready | held | failed
  → ContentDraft (provider=editorial, actionId set, brief carries the artifact hash)
  → review in Content Studio
  → createWixBlogDraftForDraft → approve → publish   existing Wix Blog code
```

## Test harness

`scripts/editorial-article.ts` runs one article end to end for a site/action.
It is a harness, not the production route.

```bash
set -a; . /SEO/.env; . /SEO/.env.local; set +a
export EDITORIAL_URL=http://127.0.0.1:8790
export EDITORIAL_TOKEN=...            # tenant-scoped token, never committed

npx tsx scripts/editorial-article.ts \
  --site atelier-harmonie.com \
  --action <researchActionId> \
  --wix-draft
```

- `--dry-run` prints the brief and the selected evidence bundle without calling
  editorial.
- `--fresh` appends a development suffix to the idempotency key. Do not use it
  in production; the key is `crawlseo:action:<id>:rev:<revision>`.
- Without `--wix-draft` the harness stops after the reviewed `ContentDraft`.
- It never calls `approve` or `publish`. Those stay with the owner and the
  existing routes.

## Evidence

The bundle is built from the latest completed crawl: the product page that
matches the action's query, one related editorial post, and the homepage.
Boilerplate pages (CGV, privacy, cookies) are excluded, and pages under 500
characters of text are dropped. Editorial verifies every quote against this
exact text; a page that was not in the bundle cannot support a claim.

## Why not the Content Studio writer route

`POST /api/sites/[siteId]/content-studio/drafts` generates synchronously and is
bounded by the request proxy. Editorial is asynchronous by design: provider
latency has ranged from seconds to minutes. The harness polls, so a slow
provider cannot turn into a failed button press.

When this is promoted to a route, it should be a new endpoint that starts the
editorial post, returns `202`, and reconciles the `ContentDraft` when the post
reaches `ready` — not a longer-lived version of the current handler.
