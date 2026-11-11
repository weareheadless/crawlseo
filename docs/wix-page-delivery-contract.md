# Wix page delivery contract

A new page is not finished when its copy is written. On both Wix sites a page
is a custom element registered early by a compressed packet, and it is only
reachable when an existing page links to it. This is the contract a page task
follows.

Source of truth for the mechanics: `/home/admin/wix-site-bridge/docs/GLOBAL_EARLY_REGISTRATION.md`
and `sites/atelier-harmonie/production/PACKET_SCOPES.md`.

## 1. The page is a custom element with an early packet

Wix loads a custom element's source from its own CDN after the document. A page
that waits for that loader renders late; an HTML embed is worse, because the
bridge mounts it 2.5 s after load. The site's own pages avoid both by
registering the element from a HEAD packet.

A page task therefore produces:

| Artifact | Who | Where |
| --- | --- | --- |
| `page.html` | the agent | the reviewed fragment |
| component source | the app | `<repo>/src/public/custom-elements/<tag>.js` |
| early packet | the app | Wix Custom Code, HEAD, ESSENTIAL, load-once |
| `design-notes.md` | the agent | task artifact |
| `navigation.md` | the agent | task artifact |

The component renders the fragment into the light DOM, so the copy stays in the
document for crawlers. JSON-LD is moved to `document.head` on connect, because
structured data inside a custom element is not read.

The packet is gzip + base64, chunked at 14,000 characters (Wix rejects an entry
at 15,000). It only runs on its own route, honours `?earlyElements=off`, and
guards `customElements.define` with `customElements.get`.

### What stays human

Wix has no API for adding an element to a page, and it exposes the Custom Code
page filter as read-only. So two steps stay with the person:

1. Place `<tag>` on the page in the Wix editor (Embed a custom element).
2. Narrow the packet's page scope in Wix Custom Code to that page.

Until step 1 the page is blank; the packet is already live, so it renders as
soon as the element is placed. Until step 2 the packet transfers on every page
but is inert, because it checks the route itself.

The task page shows the tag, the steps, and a **Check the page now** button. The
worker also probes every 15 minutes for a day. When the tag appears, the task
publishes and any earlier embed for that route is disabled, because the embed
would replace the page container and hide the element.

### Sites without a repository

A site with no `repoPath` keeps the HTML embed lane. The embed is the fallback,
not the target: it is slower and cannot be registered early.

## 2. The page is reachable

A page nobody links to is not delivered. The agent reads the site's navigation,
footer and related pages and writes `navigation.md` with one chosen target, the
exact edit, the link text and href, and what it rejected.

The choice is the model's: it knows which menu a buyer uses for this kind of
page. The app does not guess a menu from a route.

Applying the edit is a code change to a repository component (the navbar, a
category page) or a Wix editor change (the native mobile menu). The task page
shows the proposal; the edit is applied with the same review as the page.

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
- The site has no startup build script, so a page packet is self-registering.
