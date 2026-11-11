# Wix delivery loop

The loop turns an accepted proposal into a delivered page or article. Research,
drafting and validation stay automatic. The human accepts the proposal, reviews
the exact deliverable, and confirms once. The agent performs every mechanical
step after that confirmation.

## Delivery lanes

| Lane | Used for | Deliverable | Human step |
|---|---|---|---|
| Page | A new landing page (the action has no target URL) | Component source in the site repository, plus a HEAD early packet and a BODY_END page mount | Create a blank, published Wix page at the route |
| Article | An article proposal | A Wix Blog post | None beyond review |
| Component | An update to an existing page, or a technical fix | An edit to the page's own component source, with its early packet kept in step | None beyond review |

A page is three artifacts, not one embed. The packet registers the element
before Wix's own loader runs; the mount puts the element on the page. Both are
Custom Code entries the bridge creates and rewrites; the human only creates the
empty page. Do not describe a page delivery as "an embed".

Mechanics: [Wix page delivery contract](wix-page-delivery-contract.md) and the
bridge's `docs/PAGE_DELIVERY.md`. This document is the product loop; those are
the artifact rules.

The lane is chosen from the action, not from the tenant:

- `format === "article"` or `kind === "article"` → article.
- A technical action, or any action that already names a target page → component.
- A content action with no target page → page.

A landing page is a page, not an article. An article is published through Wix
Blog and never needs a page, a packet or a mount.

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
- `APPROVED`: every locale's route is probed. A live route goes straight to
  delivery.
- `AWAITING_TARGET`: a route does not answer yet. The task page states the
  exact route, page title and meta description to create. The worker probes
  every 15 minutes for 24 hours, then parks the task; the task page's check
  button resumes it at any time.
- `PUBLISHING`: writes the component source, then creates or rewrites the
  locale's HEAD packet and BODY_END mount. An older HTML embed for the route is
  disabled, because it would replace the page container.
- `PUBLISHED`: both entries read back the stored hash and the rendered document
  contains the element tag. A route that answers but has not rendered the
  element stays in `AWAITING_TARGET` (Wix may still be serving a cached
  document) instead of failing.

## What a page delivery writes

| Artifact | Written by | Where |
|---|---|---|
| `page.<locale>.html` | the agent | the reviewed fragment, one per locale |
| component source | the app | `<repo>/src/public/custom-elements/<tag>.js`, committed and pushed |
| early packet | the bridge | Custom Code, HEAD, ESSENTIAL, reload on every page |
| page mount | the bridge | Custom Code, BODY_END, ESSENTIAL, reload on every page |
| `design-notes.md` | the agent | task artifact |
| `navigation.md` + `navigation.json` | the agent | task artifact |

Both entries carry the same route and language guard, so a site-wide entry is
inert everywhere except its own page. They must never both mount content: the
packet only registers, the mount only places. Both run on every page; Wix's
load-once setting only runs at the initial site render and would miss an
internal navigation.

## Why the page is manual

Wix has no public API to create a site page. Its Pages API lists an app's own
pages; site pages belong to the site design and are created in the editor. A
Custom Embed's page filter is read-only, so a new entry is site-wide at the API
level and guards itself by route. The route must exist for the mount to render.

The entries are not manual. The bridge creates and rewrites them through the
documented Custom Embeds API (`create-snippet`, `write-packet`). The human
creates one blank page, once. There is no editor placement step: the mount adds
the element to the page container.

## Bridge contract

`inspect` reports `contract: "wix-bridge-generic-v1"` and an explicit
`capabilities` object. The host negotiates operations from it and fails closed
when an operation is not declared.

- `create-snippet`: creates a Custom Embed, returns the embed id and the stored
  hash. CrawlSEO passes `--all-pages`, because the script carries its own guard.
- `write-embed`: writes a fragment into an embed whose name starts with
  `CrawlSEO`. It re-applies the route guard, so a write cannot widen the embed
  to every page. It refuses any other embed, so a human's embed is never
  overwritten.
- `write-packet`: rewrites one CrawlSEO early packet or page mount in place, by
  embed id. It refuses any name that is not `CrawlSEO early packet` or
  `CrawlSEO page mount`.
- `disable-embed`: disables an embed CrawlSEO created, used when a page moves
  off the embed lane. It refuses any name that does not start with `CrawlSEO`.
- `read-embed`: reads an embed by id without requiring it in the site manifest.

The bridge recognizes its own entries by the `CrawlSEO` name prefix, never by a
per-site list, so a retry rewrites the entry it created instead of adding a
second one.

## Verification

- The stored hash is the hard check: Wix must return exactly the bytes the
  bridge wrote, for the packet and for the mount.
- The live DOM check is best effort: the rendered document must contain
  `<tag>`. The element mounts after the page loads, so a miss is reported as
  `liveVerified: false` / `AWAITING_TARGET`, not as a failed publish.
- Check the page on a fresh load and through an internal link. HTTP 200 alone
  is not proof the element rendered.
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

Updating a native Wix page in place needs a section mount: the mount must add a
section without replacing the page's existing content. The mount replaces the
page container, so the page lane is limited to pages the mount owns. Existing
page updates keep the component lane until section mounts are built.
