# Social posting pipeline — plan and issue map

**Status: revised 2026-11-24.** Waves 1 and 2 are merged or in review. The
eligibility apparatus described in the first draft is gone: the rule is one line,
and three of the crawlseo tickets are closed rather than reshaped.

## What the proof showed

The design pipeline was not the weak part. A single model call, given brand
assets and the copy, produces a publishable cover; the multi-stage
propose → verify → revise loop mostly manufactured the failures it then repaired.

The weak part was the subject. A freshness-decay opportunity about the Mandarin
Oriental Kanai launch became a post that promoted a development Susi does not
represent, illustrated with a photograph of a different building, quoting a
price band that contradicts every published source.

That is a post about an event in the world. The pipeline does not need to make
those, and everything it needed in order to try — crawl lookups, claim
extraction, hashed sources, live re-checks, a commentary quota — existed only to
police them.

## The rule

A social post may exist only for an opportunity a human actioned.

```
Opportunity.status: detected → accepted → in_progress → delivered
                    └──────── set by a human, decidedBy/decidedAt ────────┘
```

`accepted`, `in_progress` and `delivered` may produce a post; `detected`,
`parked` and `rejected` may not. One opportunity produces at most one post.

That is the whole gate. No crawl lookup, no delivery lookup, no claim extraction,
no fetch, no model call in the decision.

Four mechanical guards sit behind it, none of them about eligibility:

1. **Copy** comes from the opportunity brief and the brand's own knowledge. No
   number, name or date that the brief does not hold.
2. **Image** comes from the brand's own library, never a stand-in for a
   building or a project.
3. **Render** must pass Cicero's deterministic gate (SOC-011).
4. **Once** — a unique `opportunityId` on the social link.

## Why the gates were dropped

The nine gates and their reason codes were written to answer "is this true about
the world, and may we say it?" Against an opportunity a human is acting on, that
question is already answered by the human. Keeping the apparatus would have
meant:

- **Latency in the wrong direction.** The site publishes weekly and the crawl
  runs weekly, so a "page must be in the snapshot" gate refuses the newest work
  and then waits for the crawler — inverting a pipeline whose value is freshness.
- **Silent coupling.** A crawl outage would read as `NO_GROUNDING` on every
  opportunity: a pipeline failure that looks exactly like an editorial judgement,
  which is the same class of error as the proof.
- **New inventory as the hardest case.** A new listing or project may have no
  page yet at all. A page-shaped gate makes the post a real-estate brand most
  wants to make the one it cannot represent.

The crawl's remaining job is discovery: it finds the opportunity. It is a cache
of the world, not an authority over what the brand may say.

## Division of labour

| System | Owns |
|---|---|
| CrawlSEO | opportunity, evidence, the human decision, copy brief, delivery receipt, measurement |
| Editorial | writes and verifies the copy into an artifact; never publishes |
| Cicero | renders brand assets into media, runs the deterministic gate, publishes to Meta, returns a receipt |

Brand identity is one record — `SiteProfile` in CrawlSEO (palette, fonts, voice,
locales, services, topics, logo reference, represented projects). Cicero keeps no
brand registry of its own; it reads the profile and caches it.

This follows the fleet rule: a brand is identity and mappings, never a fork of the
pipeline. One connection CrawlSEO → Cicero, one CrawlSEO → Editorial, with the
brand mapped inside each. No per-brand enable flags, URLs or release steps.

## Scheduling

The trigger is the human decision, not a clock: when an opportunity is actioned,
its post may be made. Cadence (SOC-008) then decides whether this action is the
moment to publish, so a burst of seven actioned opportunities does not become
seven posts in an hour.

The site's weekly publish and the weekly crawl stay as they are. The targeted
crawl on delivery (SOC-005) keeps the snapshot aligned for the crawl's own
consumers — the recommendation run, coverage, the board. Social no longer depends
on it, and a broken crawl cannot stop a post.

## Issues

Prefix `SOC-`. Each issue is self-contained; this document is the shared map.

### Wave 1 — foundations

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-011 | cicero | Render gate library with fixtures | [#1](https://github.com/weareheadless/cicero/issues/1) — merged |
| SOC-012 | cicero | One design call; delete the propose/verify/revise pipeline | [#2](https://github.com/weareheadless/cicero/issues/2) — merged |
| SOC-003 | crawlseo | An actioned opportunity may become one social post | [#191](https://github.com/weareheadless/crawlseo/issues/191) — merged |
| SOC-016 | crawlseo | Opportunity summaries must not assert specifics nobody verified | [#197](https://github.com/weareheadless/crawlseo/issues/197) |

SOC-016 belongs in wave 1: the copy is now written from the opportunity summary,
so it is the check that the brief holds only verified specifics.

### Wave 2 — identity and contract

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-007 | crawlseo | SiteProfile: brand block and representation | [#195](https://github.com/weareheadless/crawlseo/issues/195) — merged |
| SOC-013 | cicero | Read brand identity from SiteProfile, not brand.json | [#3](https://github.com/weareheadless/cicero/issues/3) — merged |
| SOC-009 | editorial | Social artifact type in the brief/artifact contract | [#1](https://github.com/weareheadless/editorial/issues/1) — merged |
| SOC-010 | editorial | Verify social artefacts | [#2](https://github.com/weareheadless/editorial/issues/2) — merged |

### Wave 3 — the lane

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-014 | cicero | Social render + publish API for the delivery adapter | [#4](https://github.com/weareheadless/cicero/issues/4) — merged |
| SOC-006 | crawlseo | Publish an actioned opportunity through Cicero, once | [#194](https://github.com/weareheadless/crawlseo/issues/194) |

SOC-006 is the whole lane: one function that asks `decideSocialPost`, calls
Cicero's two endpoints and writes a `SocialPost` receipt. There is no adapter, no
delivery state machine and no Meta code in CrawlSEO — Cicero owns the Page, the
token and the draft flag, and a second publisher here would duplicate it.

### Cross-cutting

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-005 | crawlseo | Crawl after delivery: refresh the delivered URLs | [#193](https://github.com/weareheadless/crawlseo/issues/193) |
| SOC-017 | cicero | Meta production access, token custody and the Page runbook | [#6](https://github.com/weareheadless/cicero/issues/6) |

SOC-017 blocks any use beyond this one Page. SOC-005 is the crawl's own concern
and is no longer on the social path.

### Wave 4 — steering

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-008 | crawlseo | A weekly post cap, and a readout of the receipts | [#196](https://github.com/weareheadless/crawlseo/issues/196) |
| SOC-015 | cicero | Retire Cicero's product surface and clean up the POC | [#5](https://github.com/weareheadless/cicero/issues/5) |

## Closed

Closed on 2026-11-24, superseded by SOC-003. The reasoning is in each closing
comment; kept here so the first draft can be read against the second.

| Issue | Repo | Title | Ticket |
|---|---|---|---|
| SOC-001 | crawlseo | Social eligibility: rules-first gates, decision rows, reason codes | [#189](https://github.com/weareheadless/crawlseo/issues/189) |
| SOC-002 | crawlseo | Claim-level grounding from the crawl, verified live at post time | [#190](https://github.com/weareheadless/crawlseo/issues/190) |
| SOC-004 | crawlseo | Commentary lane: news grounded in hashed sources, with quota | [#192](https://github.com/weareheadless/crawlseo/issues/192) |

## Open decisions

- **Draft-first or publish?** The proof posted an unpublished photo first. Keep
  that as the default until a human has approved a week of posts.
- **Cadence.** Start at two posts a week per channel; tune from the decision
  telemetry, not from taste. There is no commentary quota because there is no
  commentary lane: a market comment is a manual post by a human, outside the
  pipeline.
- **Locales.** The site is EN/ES. A post is written natively per locale, never
  machine-translated; a locale without an approved artifact does not ship.
- **Meta production access.** The app is still in development mode; scheduled
  publishing for users outside the app's roles needs app review and business
  verification. Track separately when the fleet grows past one Page.
