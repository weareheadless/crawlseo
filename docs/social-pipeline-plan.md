# Social posting pipeline — plan and issue map

**Status: plan agreed 2026-11-24, implementation starting.** One social post was
produced end to end as a proof (CrawlSEO opportunity → Cicero render → Facebook
Page). It exposed where the decisions actually live, and this plan moves them.

## What the proof showed

The design pipeline was not the weak part. A single model call, given brand
assets and the copy, produces a publishable cover; the multi-stage
propose → verify → revise loop mostly manufactured the failures it then repaired.

The weak part was eligibility. A freshness-decay opportunity about the Mandarin
Oriental Kanai launch became a post that promoted a development Susi does not
represent, illustrated with a photograph of a different building, quoting a
price band that contradicts every published source. Each of those is a decision
that must be made before a render is allowed to exist, and each of them is
decidable from data we already hold.

## The invariant

A post may exist only when all of the following are true, and each one is
recorded with the decision:

1. the subject is inside the brand's service area and offered services;
2. the post is grounded — a claim quoted from a live page, or a source that was
   fetched and hashed;
3. the brand has the right to promote the subject (represented listing, own
   service, or commentary on a named third party);
4. the image provenance matches the subject (own photo of it, labelled generic
   location image, or no image);
5. the claim still holds at post time (hash comparison against the live page);
6. the post is not a repeat (page + claim inside the dedupe window), and the
   channel is inside its cadence.

Anything that fails is rejected with a reason code. Rejection is the default and
the expected majority.

## Division of labour

| System | Owns |
|---|---|
| CrawlSEO | opportunity, evidence, crawl snapshot, eligibility decision, approval, delivery receipt, measurement |
| Editorial | writes and verifies a brief into an artifact; never publishes |
| Cicero | renders brand assets into media, runs the deterministic gate, publishes to Meta, returns a receipt |

Brand identity is one record — `SiteProfile` in CrawlSEO (palette, fonts, voice,
locales, service area, logo reference, represented projects). Cicero keeps no
brand registry of its own; it reads the profile and caches it.

This follows the fleet rule: a brand is identity and mappings, never a fork of
the pipeline. One connection CrawlSEO → Cicero, one CrawlSEO → Editorial, with
the brand mapped inside each. No per-brand enable flags, URLs or release steps.

## Scheduling

The site publishes weekly and the crawl runs weekly (`cycle:<week>:crawl`,
`lib/jobs/site-cycle.ts`), keyed by ISO week. They are not linked, so a page
published on Monday is invisible to the snapshot until the next tick. The crawl
must also run **on delivery**, refreshing only the delivered URLs. The weekly
cycle stays as the backstop; the delivery trigger keeps the snapshot aligned
with what the site actually published.

## Issues

Prefix `SOC-`. Each issue is self-contained; this document is the shared map.

### Wave 1 — foundations

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-011 | cicero | Render gate library with fixtures | [#1](https://github.com/weareheadless/cicero/issues/1) |
| SOC-012 | cicero | One design call; delete the propose/verify/revise pipeline | [#2](https://github.com/weareheadless/cicero/issues/2) |
| SOC-001 | crawlseo | Social eligibility: rules-first gates, decision rows, reason codes | [#189](https://github.com/weareheadless/crawlseo/issues/189) |
| SOC-002 | crawlseo | Claim-level grounding from the crawl, verified live at post time | [#190](https://github.com/weareheadless/crawlseo/issues/190) |
| SOC-005 | crawlseo | Crawl after delivery: refresh the delivered URLs | [#193](https://github.com/weareheadless/crawlseo/issues/193) |

### Wave 2 — identity and contract

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-007 | crawlseo | SiteProfile: brand block and representation | [#195](https://github.com/weareheadless/crawlseo/issues/195) |
| SOC-013 | cicero | Read brand identity from SiteProfile, not brand.json | [#3](https://github.com/weareheadless/cicero/issues/3) |
| SOC-009 | editorial | Social artifact type in the brief/artifact contract | [#1](https://github.com/weareheadless/editorial/issues/1) |
| SOC-010 | editorial | Verify social artefacts: claims, representation, provenance | [#2](https://github.com/weareheadless/editorial/issues/2) |

### Wave 3 — the lanes

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-003 | crawlseo | Defer create_asset social output until the article is delivered | [#191](https://github.com/weareheadless/crawlseo/issues/191) |
| SOC-004 | crawlseo | Commentary lane: news grounded in hashed sources, with quota | [#192](https://github.com/weareheadless/crawlseo/issues/192) |
| SOC-014 | cicero | Social render + publish API for the delivery adapter | [#4](https://github.com/weareheadless/cicero/issues/4) |
| SOC-006 | crawlseo | meta_facebook delivery lane with receipts and idempotency | [#194](https://github.com/weareheadless/crawlseo/issues/194) |

### Cross-cutting

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-016 | crawlseo | Opportunity summaries must not assert specifics nobody verified | [#197](https://github.com/weareheadless/crawlseo/issues/197) |
| SOC-017 | cicero | Meta production access, token custody and the Page connection runbook | [#6](https://github.com/weareheadless/cicero/issues/6) |

SOC-016 runs beside wave 1: it stops the generated summary from being the source
of a claim. SOC-017 blocks any use beyond this one Page.

### Wave 4 — steering

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-008 | crawlseo | Cadence policy and decision telemetry | [#196](https://github.com/weareheadless/crawlseo/issues/196) |
| SOC-015 | cicero | Retire Cicero's product surface and clean up the POC | [#5](https://github.com/weareheadless/cicero/issues/5) |

## Open decisions

- **Draft-first or publish?** The proof posted an unpublished photo first. Keep
  that as the default until a human has approved a week of posts.
- **Cadence.** Start at two posts a week per channel, at most one commentary
  post in four; tune from the decision telemetry, not from taste.
- **Locales.** The site is EN/ES. A post is written natively per locale, never
  machine-translated; a locale without an approved artifact does not ship.
- **Meta production access.** The app is still in development mode; scheduled
  publishing for users outside the app's roles needs app review and business
  verification. Track separately when the fleet grows past one Page.
