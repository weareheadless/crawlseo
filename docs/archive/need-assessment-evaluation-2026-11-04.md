# Customer-need qualification — real evaluation, 2026-11-04

This is the reviewable record of the real (not mocked) assessment runs for the
qualification boundary. The command is reproducible; the full JSON for each run is
written to `/tmp/opencode/` by the command shown.

```
npx tsx scripts/evaluate-need-assessment.ts --domain=<domain> \
  --finding="<theme substring>" --max-findings=1 --max-pages=6 \
  --out=/tmp/opencode/<name>.json
```

The script reads the tenant and its findings, selects candidate pages from the crawl
inventory, retrieves their public text, reuses the real extraction core when business
knowledge is missing, and runs the real model assessment. It writes no knowledge
revision, opportunity, task or paid search call.

## Susi — foreign ownership and fideicomiso

Finding: *"Source 6 directly ranks a competitor article on how foreigners can buy land
in the Riviera Maya, naming fideicomiso and Mexican company structures. No candidate
page addresses foreign ownership or restricted-zone land."*

Pages retrieved (4):

- `/post/fideicomisos-unlocking-real-estate-opportunities-in-mexico-s-restricted-zones`
- `/post/how-to-buy-your-dream-home-in-mexico-as-a-foreigner`
- `/post/tulum-international-airport-accelerating-real-estate-and-tourism-in-the-mexican-caribbean`
- `/`

Assessment: premise **contradicted**; need unverified; offer fit supported; coverage
`partially_answers` on both foreign-ownership posts. Quotes returned by the model:

> "non-citizens can use a fideicomiso to purchase property in these restricted zones"
> — fideicomisos post

> "foreigners cannot own land within 100 kilometers of the border or 50 kilometers of
> the coast" — how-to-buy post

Decision: **rejected** / maintain / unquantified.

> "The finding says no candidate page addresses foreign ownership or restricted-zone
> land, but two supplied posts do. One is specifically about fideicomisos in Mexico's
> restricted zones, and the other explains that foreigners cannot own land within the
> restricted zone and says there are two options."

## Atelier — off-topic corpus

Finding: *"Corpus de sources hors sujet"* (Canadian parliamentary seats, a download
tax, an unrelated multilingual text; no source about upholstery or lampshades).

Pages retrieved (6): home, `/blog/tags/restauration`,
`/tapisserie-restauration`, `/en/tapisserie-restauration`, two restoration posts.

Decision: **rejected** / maintain / unquantified.

> "the research found its own sources unusable, so this is a pipeline-quality failure
> rather than a customer need"

## Atelier — lampshade service page

Finding: *"Abat-jour sur mesure sans page dédiée"*.

Pages retrieved (8) included the real dedicated pages:
`/lampes/abat-jours`, `/en/lampes/abat-jours`, `/category/abat-jours`,
`/en/category/abat-jours`, a restoration post, home, two product pages.

Assessment: coverage `unassessable` for `/lampes/abat-jours` and
`/en/lampes/abat-jours`; the retrieved HTML for those Wix pages contains only the
title and page chrome, not the rendered body. Decision: **research backlog** /
investigate / unquantified. No work was proposed.

Honest limitation: the live fetch does not execute JavaScript. This case is not
evidence that the page lacks an answer; it is evidence that live HTML retrieval cannot
read this page. A crawl that stores rendered text (or a headless fetch) is required.

## Casamigo — Mexico City

Finding: *"Mexico City not covered by site inventory"*.

Pages retrieved (7): home, three market posts, `/pulse`, a Playa del Carmen property.

Assessment: need unverified; offer fit **contradicted**; coverage `does_not_answer`
on the pages that were read.

> "The supplied business facts limit the service area to Riviera Maya markets including
> Playa del Carmen, Tulum, Cancún, Puerto Morelos, Cozumel and Bacalar, with the
> business located in Playa del Carmen. Mexico City is outside the stated service area
> and no supplied fact shows Casamigo serves that market."

Decision: **rejected** / maintain / unquantified.

## Unseen tenant — automatic extraction

Site: an Astrid preview site with no business-knowledge document and no findings.

Pages read: 8 (home, `/en/`, `/novias/`, `/en/bridal/`, `/color-y-corte/`,
`/en/color-and-cuts/`, `/en/makeup-and-hair/`, `/maquillaje-y-peinado/`).

Extraction: language `es`; 9 fields found — businessName, services, location,
serviceArea, differentiators, audienceMotivations, concerns, conversionGoals, voice.
Examples: "Astrid Rincón", services "Color y corte, Balayage, Retoque de raíz,
Maquillaje y peinado, Novias", location "Playa del Carmen, México".

Written: false. No knowledge revision, no recommendation, no task. With no evidenced
finding, the correct output is no work.

## What is deterministic and what is not

- `tests/need-assessment.test.ts`, `tests/funnel-decision.test.ts`,
  `tests/customer-recommendations.e2e.test.ts` and the tenant fixtures are
  deterministic regressions. They prove the wiring and the validation rules, not that
  the model reasons well. The fixtures say so in their comments.
- The runs above are single real observations. They are not a statistically
  meaningful evaluation of model quality and have not had independent SEO review.
- Existing evidence rows have no assessment and remain research backlog until the
  monthly bridge re-processes them. No production board was refreshed.

## Commands and results

```
npx tsc --noEmit                                   # clean
npx vitest run --exclude '**/.agent-worktrees/**' --exclude '**/.agent-tools/**'
# 1005 passed, 16 skipped
npm run build                                      # compiled successfully
DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 npx vitest run \
  tests/customer-recommendations-postgres.integration.test.ts
# 4 passed
```
