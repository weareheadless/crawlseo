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
bridge for both entries; the person creates only the blank Wix page.

## 1. A deployment is two entries, not one

Wix loads a custom element's source from its own CDN after the document. A page
that waits for that loader renders late; an HTML embed is worse, because the
bridge mounts it 2.5 s after load. The site's own pages avoid both with a HEAD
script that registers the element before Wix's loader runs, and a body embed
that puts the element on the page.

So a deployment writes both, and they do different jobs:

| Entry | Position | Scope | Job |
| --- | --- | --- | --- |
| early packet | HEAD, ESSENTIAL, load-once | general custom code, all pages | decompress the source and register the element |
| page mount | BODY_END, ESSENTIAL | general custom code, all pages | create the element and put it in the page container |

They must never both mount. The packet registers and touches nothing else; the
mount creates the element and re-mounts it through Wix hydration for the first
minute, because hydration replaces the page container after first paint. Both
carry the same route and language guard, so an entry that is site-wide is inert
everywhere except its own page.

A page task therefore produces:

| Artifact | Who | Where |
| --- | --- | --- |
| `page.<locale>.html` | the agent | the reviewed fragment, one per locale |
| component source | the app | `<repo>/src/public/custom-elements/<tag>.js` |
| early packet | the app, through the bridge | Wix Custom Code, HEAD, ESSENTIAL, load-once |
| page mount | the app, through the bridge | Wix Custom Code, BODY_END, ESSENTIAL |
| `design-notes.md` | the agent | task artifact |
| `navigation.md` + `navigation.json` | the agent | task artifact |

The component renders the fragment into the light DOM, so the copy stays in the
document for crawlers. JSON-LD is moved to `document.head` on connect, because
structured data inside a custom element is not read.

The packet is gzip + base64, chunked at 14,000 characters (Wix rejects an entry
at 15,000). It only runs on its own route, honours `?earlyElements=off`, and
guards `customElements.define` with `customElements.get`.

### Locales

A site publishes several locales (`SiteProfile.locales`). Each locale gets its
own component tag, its own packet and its own mount, because the guard differs:

- a locale selected by a path prefix (`/en/...`) guards its own route;
- a locale selected by a query (`lang=es`) also requires that query, and the
  default locale's entry excludes it;
- the default locale's entry also answers its explicit prefix (`/fr/...`), but
  never another locale's prefix.

Every locale's page is written from scratch in its language, not translated.

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
