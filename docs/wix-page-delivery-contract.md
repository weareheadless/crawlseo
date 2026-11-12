# Wix page delivery contract

A new page is not finished when its copy is written. On both Wix sites a page
is a custom element registered early by a compressed packet, mounted by the
page's own mount entry, and it is only reachable when an existing page links to
it. This is the contract a page task follows.

Source of truth for the mechanics: `/home/admin/wix-site-bridge/docs/PAGE_DELIVERY.md`.
The current page scope of each deployed entry is the operator table
`sites/atelier-harmonie/production/PACKET_SCOPES.md`.

A delivery is three artifacts: the component source in the site repository, the
HEAD packet and the BODY_END mount. The app writes the source and calls the
bridge for both entries; the person creates only the blank Wix page. A page's
SEO title and meta description are a page setting, not a fourth artifact: the
app sets them through the Item SEO Tags API after the page is published.

Those artifacts are drafts until the site is published. The delivery therefore
ends with a publish and a read of the live document, in this order: write the
packet and mount, push the source, publish the site, verify the live page
serves the new packet, then set and verify the SEO tags. A publish restores page
settings from its saved revision, which is why the SEO tags come last, and a
publish triggered by the source push can restore an older revision, which is
why the live packet is verified and the publish retried when it is not there.

## 1. A deployment is two entries, not one

Wix loads a custom element's source from its own CDN after the document. A page
that waits for that loader renders late; an HTML embed is worse, because the
bridge mounts it 2.5 s after load. The site's own pages avoid both with a HEAD
script that registers the element before Wix's loader runs, and a body embed
that puts the element on the page.

So a deployment writes both, and they do different jobs:

| Entry | Position | Scope | Job |
| --- | --- | --- | --- |
| early packet | HEAD, ESSENTIAL, reload on every page | general custom code, all pages | decompress the source and register the element |
| page mount | BODY_END, ESSENTIAL, reload on every page | general custom code, all pages | create the element and put it in the page container |

They must never both mount. The packet registers and touches nothing else; the
mount creates the element and re-mounts it through Wix hydration for the first
minute, because hydration replaces the page container after first paint. Both
carry the same route and language guard, so an entry that is site-wide is inert
everywhere except its own page.

Both entries must have Wix's load-once setting **off**. With load-once on, Wix
runs the entry only during the initial site render, so a visitor who reaches the
page by an internal navigation would never mount it. The app sets it off on
create and corrects it on every rewrite.

A page task therefore produces:

| Artifact | Who | Where |
| --- | --- | --- |
| `page.<locale>.html` | the agent | the reviewed fragment, one per locale |
| component source | the app | `<repo>/src/public/custom-elements/<tag>.js` |
| early packet | the app, through the bridge | Wix Custom Code, HEAD, ESSENTIAL, reload on every page |
| page mount | the app, through the bridge | Wix Custom Code, BODY_END, ESSENTIAL, reload on every page |
| `design-notes.md` | the agent | task artifact |
| `navigation.md` + `navigation.json` | the agent | task artifact |

The component renders the fragment into the light DOM, so the copy stays in the
document for crawlers. JSON-LD is moved to `document.head` on connect, because
structured data inside a custom element is not read.

### Page SEO

A pushed page is not finished without its own title and meta description: Wix
otherwise shows a page-type pattern ("abat-jour sur mesure | Atelier de
l'Harmonie") and, often, no description at all. Every page delivery therefore
ends with a check (`lib/delivery/page-seo.ts`):

The check runs after the code push, because a push triggers a Wix build whose
publish restores the saved revision and would undo a publish done before it.

- A page that already carries its own title and description keeps them.
- A page that still inherits the pattern gets both written, from the brief's
  values when it has them, otherwise from its copy by the content model.
- The copy is read from a rendered document, walking shadow roots: the site's
  own components render their body there, so a plain DOM dump reports such a
  page as empty.
- The result is read back from the live document, not from the API response.

On a multi-locale site the check runs on the primary page. Wix writes SEO tags
for the primary language only, so a translated page sets its own title,
description and `og:*` tags from its component, and that is verified in a
rendered document.

Wix page title and meta description are not Custom Embed content, so they are
not part of the packet. When a page config supplies `seo.title` and
`seo.description`, the delivery calls the bridge's `seo-tags` operation. The
bridge lists `STATIC_PAGE` items, matches the route against the canonical link
the page's SEO tags already carry, replaces only the title and description, and
publishes the existing page revision with `publish: true`. It never publishes
the whole site.

This uses a Wix API key with `Manage SEO Settings` (`WIX_SEO_API_KEY`); the
installed app token that Custom Embeds use gets HTTP 403 on the Item SEO Tags
API. The same key publishes the site (`POST /site-publisher/v1/site/publish`).
A failure is reported in the delivery result and does not hide a page that
already rendered. The Wix page must exist and be published first; the API cannot
create it.

The packet is gzip + base64, chunked at 13,500 characters (Wix rejects an entry
at 15,000). Chunks write indexed slots and any chunk that completes the set
decompresses it, so loading them in any order or rerunning them on navigation
cannot corrupt the payload. It only runs on its own route, honours
`?earlyElements=off`, and guards `customElements.define` with
`customElements.get`. A shorter source disables the chunks it no longer needs.

### Locales

A site publishes several locales (`SiteProfile.locales`). Each locale gets its
own component tag, its own packet and its own mount, because the guard differs:

- a locale selected by a path prefix (`/en/...`) guards its own route;
- a locale selected by a query (`lang=es`) also requires that query, and the
  default locale's entry excludes it;
- the default locale's entry also answers its explicit prefix (`/fr/...`), but
  never another locale's prefix.

Every locale's page is written from scratch in its language, not translated.

### Repairing a published page

`npm run repair:wix-page -- <taskId> --apply` re-delivers a published page from
its stored fragment. It regenerates both entries from the current builders,
rewrites them in place, sets load-once off on both, disables leftover chunks and
checks the live element. It does not change the task's review state or push to
GitHub.

### What stays human

Wix has no API for creating a page. The person creates the page at the route in
the Wix editor; everything after that is the agent's. Delivery probes every
locale's route first and parks the task in `AWAITING_TARGET` until they answer,
then deploys both entries for every locale.

A locale whose element has not appeared in the rendered document parks the task
instead of failing it: the entries are deployed and Wix may still be serving a
cached document. The worker re-checks and publishes when the element appears,
and an earlier HTML embed for that route is disabled, because the embed would
replace the page container and hide the element.

### Sites without a repository

A site with no `repoPath` keeps the HTML embed lane. The embed is the fallback,
not the target: it is slower and cannot be registered early.

## 2. The page is reachable

A page nobody links to is not delivered. The agent reads the site's navigation,
footer and related pages and writes `navigation.md` with the chosen target, the
link text and href, and what it rejected.

The choice is the model's: it knows which menu a buyer uses for this kind of
page. The app does not guess a menu from a route.

The edit itself is `navigation.json`: the target file, the component name in the
site manifest, and exact `find`/`replace` strings. The app applies them instead
of retyping a large minified component, refuses a string that matches anything
but once, checks the result parses, writes the repository and rebuilds that
component's packet in the site's own format. A retry after a successful apply
reports "already applied" instead of inserting a second copy.

The task page shows the proposal, and approving applies the edit with the same
review as the page. Wix editor changes, such as the native mobile menu, stay
human.

## Atelier specifics

- Components: `src/public/custom-elements/atelier-*-v1.js`, tags share the
  `atelier-` prefix.
- The desktop menu is `atelier-navbar-v1.js`; the mobile menu is the native Wix
  header menu, so a code edit alone does not make a page reachable on a phone.
- The startup controller and its route registry are built by the site's own
  `scripts/build-startup.mjs`. A page packet is self-registering and does not
  need a controller change; the site's build can adopt the component later.

## Susi specifics

- Components: `src/public/custom-elements/*.js`, no shared tag prefix.
- Packets use `window.__susiEarlyPackets` and `window.__susiDrainEarly`.
- Spanish is a query locale (`?lang=es`), not a path prefix: `/es/` is a 404.
- The site has no startup build script, so a page packet is self-registering.
