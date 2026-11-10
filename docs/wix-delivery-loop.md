# Wix delivery loop

The loop turns an accepted proposal into a delivered page or article. Research,
drafting and validation stay automatic. The human accepts the proposal, reviews
the exact deliverable, and confirms once. The agent performs every mechanical
step after that confirmation.

## Two lanes

| Lane | Used for | Deliverable | Human step |
|---|---|---|---|
| Page | A new landing page (the action has no target URL) | A route-guarded Custom Embed | Create a blank Wix page at the route |
| Article | An article proposal | A Wix Blog post | None beyond review |
| Component | An update to an existing page, or a technical fix | The page's own component source | None beyond review |

The lane is chosen from the action, not from the tenant:

- `format === "article"` or `kind === "article"` → article.
- A technical action, or any action that already names a target page → component.
- A content action with no target page → page.

A landing page is a page, not an article. An article is published through Wix
Blog and never needs a page or an embed.

## Page lane states

```
READY → RUNNING → AWAITING_REVIEW → APPROVED → PUBLISHING → PUBLISHED
                                        ↓
                                 AWAITING_TARGET → PUBLISHING
```

- `RUNNING`: the agent writes one fragment, `page.html`, in a temporary
  workspace. It is not a repository change and is not committed.
- `AWAITING_REVIEW`: the fragment is stored as a task artifact and rendered in
  the task page. The human reads it and approves.
- `APPROVED`: the route is probed. A live route goes straight to delivery.
- `AWAITING_TARGET`: the route does not answer yet. The task page states the
  exact route, page title and meta description to create. The worker probes
  every 15 minutes for 24 hours, then parks the task; the task page's check
  button resumes it at any time.
- `PUBLISHING`: the bridge creates the embed if the route has none, or writes
  into the managed embed that already owns it.
- `PUBLISHED`: the embed hash is read back and the live page is rendered to look
  for the task marker.

## Why the page is manual

Wix has no public API to create a site page. Its Pages API lists an app's own
pages; site pages belong to the site design and are created in the editor. A
Custom Embed's page filter is read-only, so a new embed is site-wide at the API
level and the bridge wraps it in an exact-route guard. The route must exist for
the guard to mount.

The embed itself is not manual. The bridge creates it through the documented
Custom Embeds API (`create-snippet`), and later writes into it (`write-embed`).
The human creates one blank page, once.

## Bridge contract

`inspect` reports `contract: "wix-bridge-generic-v1"` and an explicit
`capabilities` object. The host negotiates operations from it and fails closed
when an operation is not declared.

- `create-snippet`: creates a Custom Embed, wraps the fragment in a route guard,
  returns the embed id and the stored hash.
- `write-embed`: writes a fragment into an embed whose name starts with
  `CrawlSEO`. It re-applies the route guard, so a write cannot widen the embed
  to every page. It refuses any other embed, so a human's embed is never
  overwritten.
- `read-embed`: reads an embed by id without requiring it in the site manifest.

## Verification

- The stored hash is the hard check: Wix must return exactly the bytes the
  bridge wrote.
- The live DOM check is best effort. The embed mounts after the page loads, so a
  miss is reported as `liveVerified: false`, not as a failed publish.
- A failed delivery keeps the reviewed fragment. Returning the task to review
  retries delivery without re-running the agent.

## Universality

- No tenant names, domains, routes or service words in `lib/`.
- The bridge alias and adapters come from `SiteDeliveryConfig`.
- Managed embeds are recognised by the `CrawlSEO` name prefix, not by a
  per-tenant list.
- The page route is a human decision for a new page; the system never invents
  one and delivers to it.

## Known boundary

Updating a native Wix page in place needs a section mount: the embed must add a
section without replacing the page's existing content. The bridge's route guard
replaces the page container, so the page lane is limited to pages the embed owns.
Existing page updates keep the component lane until section mounts are built.
