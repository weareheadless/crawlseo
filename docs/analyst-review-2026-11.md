# SEO analyst review — 2026-11 research cycle

Reviewed 2026-11-08 against the four tenant job maps, topic maps, opportunity
boards and the stored Search Console rows. This is a judgment on the output, not
a new research run.

**Verdict.** The job map is a real improvement: demand is now qualified by what
the searcher is trying to do, and the Tulum noise, world-record queries and
bare-place queries are out of demand. The topic maps are directionally right for
Casamigo, Atelier, Susi and Oceanic. The boards are useful drafts, but they are
not yet decision-ready. Three problems undermine trust: “closed” is not
verification, the headline visibility numbers are cluster sums rather than site
totals, and the job map does not cover Susi’s long tail. Two tenant-specific
errors (Atelier’s repair target and Oceanic’s beginner-course fit) would send
work to the wrong page or the wrong product.

## 1. What the demand model gets right

- **Noise is gone from demand.** Casamigo’s 534k Tulum number is no longer
  counted; `casas de cambio`, `casas de empeños` and `casas cerca de mi` are
  context/noise. Oceanic’s world-record and competition queries are excluded.
  Susi’s `hospital near me` (1,251 impressions, 5 clicks) is correctly
  out-of-market.
- **Jobs are separated.** Casamigo distinguishes buying a property, researching
  a market and evaluating a named project. Atelier separates buying a lamp,
  restoring an abat-jour, learning to repair one, and attending a workshop.
  That separation is what the old topic list could not do.
- **Unknown fit is handled honestly.** Samsara Tulum and Xaman Ha carry demand
  and no page; the map marks them `unknown` and shows a page gap instead of
  inventing an offer.
- **Excluded queries remain auditable.** The “Queries the job map excluded from
  demand” section keeps the subtraction visible. That is the right shape.

## 2. Findings that change decisions

### F1. “Closed” is a diff, not a verified fix — high

`scripts/research-opportunities.ts` computes `changes.closed` as every previous
proposal whose dedup key is absent from the current run. That is “not
re-proposed”, not “fixed”. The board then prints `closed:` for it.

The current run contradicts itself:

- **Casamigo** marks “Fix duplicate titles and missing H1 on the property
  listings template”, “Add self-referencing canonical tags to city pages” and
  “Repair broken internal links on the Costera property page” as closed, while
  the same board proposes unique titles across 122 pages, self-canonicals on
  seven city pages and broken-link repairs on 13 pages.
- **Atelier** marks “Technical metadata head-tag batch” as closed; the new board
  proposes “Pass technique balises : titles uniques et canoniques”.
- **Susi** marks “Spanish site crawl and sitemap repair” as closed; the new board
  proposes “Crawl-path and broken-link cleanup”.
- **Oceanic** marks the duplicate-title/meta repair as closed; the drafting note
  still lists “duplicate title/description on the homepage pair (2 pages)” as
  worth delivering.

Most of Casamigo’s ten closures are churn from the taxonomy change, not fixes.
This directly violates the workstream rule that closed means verified fixed. It
is the first thing to fix before anyone trusts the board.

**Recommendation:** rename the report line to “no longer proposed”; reserve
`closed` for a verified fix (latest crawl no longer shows the defect, or the page
passes a stated check, or a human accepted and completed the task). Keep a
technical-findings ledger that the drafting model cannot delete.

### F2. Board visibility numbers are cluster sums, not site totals — high

`foundationsGate` adds `cluster.metrics.impressions`, which counts only queries
that matched a topic and double-counts queries in overlapping topics. The real
window is larger:

| Tenant | Board headline | Actual window | Board CTR | Actual CTR |
|---|---:|---:|---:|---:|
| Casamigo | 29 imp / 0 clicks | 39 / 0 | 0% | 0% |
| Atelier | 2,306 / 31 | 4,066 / 62 | 1.34% | 1.52% |
| Susi | 11,639 / 38 | 29,533 / 181 | 0.33% | 0.61% |
| Oceanic | 0 / 0 | 4 / 0 | 0% | 0% |

No gate decision changes this month, but the diagnosis does. Susi’s board
understates impressions by 61% and clicks by 79%; Atelier’s clicks are halved.
A borderline site could be held on a partial count. The gate should use the
site-level Search Console totals; cluster sums stay for per-topic estimates.

### F3. Susi’s tail is unjudged — high

The job map judged 71 of Susi’s queries. About 1,060 queries — roughly 18,500
impressions and 76 clicks — have no verdict: **about 63% of the site’s
impressions and 42% of its clicks**. The board’s proposals rest on 9,588 demand
impressions and 97 clicks; the site actually has 29,533 and 181.

This is not demand inflation — the demand volume comes from judged queries — but
it means the topic map covers only a third of what the site is actually seen
for. The 900-query single call is too large for reliable full assignment, and
the correction only names queries with volume, so the zero-volume tail is never
requested.

**Recommendation:** batch the job map (for example 300–400 queries per call) and
merge verdicts; or explicitly park the unjudged tail as “not judged this cycle”
and exclude it from topic counts. Do not present a 23-topic map as complete for
Susi until the tail is judged.

### F4. Technical foundations disappear in cross-lane merges — high

The critique groups proposals that share a page and `mergeGroups` absorbs the
absorbed rows. It merges across lanes. Casamigo ends with an empty technical lane
while the current crawl has 122 duplicate-title pages, 13 broken-link pages and
seven city pages without canonicals. Atelier and Susi keep technical rows, but
they sit after five content items. Oceanic keeps only the sitemap; the
duplicate-title and canonical findings are absorbed into content proposals.

A technical defect is a prerequisite, not a sub-task. A content pass can fix it,
but the defect still needs its own foundation row and severity.

**Recommendation:** never merge across lanes. Let a content proposal reference a
technical finding, but keep the foundation item visible and order it first when
the site is not visible.

### F5. The board can target a different page than the topic owner — high (Atelier)

The topic map says `restauration-et-reparation-d-abat-jour` is owned by `/devis`
(13 queries, 346 impressions, 10 clicks, position 9.2). The board’s “Article
abat-jour” proposal uses that topic’s 190 demand and 7.6 expected clicks but
targets the DIY blog post `/post/l-art-de-la-restauration...` — the owner of the
separate `reparer-soi-meme-un-abat-jour` topic (2 queries, 80 impressions, 7
clicks, position 6.9).

That mixes two jobs. The commercial “have it repaired” job needs the service or
quote page; the DIY job needs the guide. Adding a quote CTA to the guide is not
the same as owning the commercial query.

**Recommendation:** use the topic’s owner page as the default target, and require
a stated reason when a proposal targets another URL. The board already has the
owner; it should use it.

### F6. A job can be marked “serves” from a guide, not an offer — high (Oceanic)

Oceanic’s business facts list private coaching, AIDA 3, depth/line training,
breathwork and safety — no beginner or level-1 course. The job map nevertheless
marks `beginner-freediving-course` as `serves`, with the reason “OceanicVibes
offers AIDA 3 and a Playa del Carmen course-choice guide”. AIDA 3 is an advanced
certification; a guide is content, not a product. The board’s second proposal is
to rewrite that guide for beginner course terms.

The critique itself says “if beginner courses are not sold…”, which means the
model is unsure. The 1,480 demand may be real, but it is not served demand until
the offer is confirmed.

**Recommendation:** require an offer or service page as evidence for `serves`.
If no beginner course exists, set the job to `unknown`/`does_not_serve` and keep
the guide advisory. If Oceanic launches a course, build a course page, not a
blog rewrite.

### F7. Page type is not part of coverage — medium

Oceanic’s beginner-course and breathwork topics are `service` topics whose owner
is a blog post, yet the map reports “coverage exists” and no gap. Atelier’s
repair topic is owned by a quote page. A service topic owned by content is not
the same page doing the job.

**Recommendation:** compare the owner page’s type from `pageTypeRules` with the
topic’s `coverageKind` and flag a mismatch. That is a fact check on the model’s
own page-type rules, not a code-side intent guess.

### F8. Brand demand is reported as zero — medium

Atelier’s brand queries are 228 impressions and 22 clicks — 35% of the site’s
clicks — yet the brand topic shows “no measured query demand” because brand
searches are `context`, not a job. That is correct for opportunity sizing and
wrong for brand health. Casamigo has only two brand impressions; Susi’s
brand-like queries are other people (`sabine macdonald`, `susannah macdonald`),
so the issue is Atelier-specific this month.

**Recommendation:** report brand/navigational demand separately with
impressions and clicks. Do not put it in job demand, but do not call it zero.

### F9. Priority scores are topic-level and current-band — medium

The score is `demand × CTR at the cluster’s average position × intent fit`. Two
problems:

- The position can belong to a different URL than the target. Atelier’s
  abat-jour hub has zero impressions; the 15.3 position and 15.8 expected clicks
  come from a product page. Casamigo’s Riviera Maya topic is owned by
  `/es/properties`, while the board targets the English `/properties`.
- The label is the current-band estimate, not the gain from the proposal. Susi’s
  homes page at position 59.5 showing 17 expected clicks is a benchmark, not a
  forecast of what a title pass will produce.

**Recommendation:** use the target page’s measured position when available, and
show both “current-band clicks” and “upside at top 10/top 3”. Say plainly that
the number is a planning estimate.

### F10. Demand geography is unstated — medium

The demand figures are DataForSEO volume, which is national/global unless
localized. `torre 25` at 1,600 and `freediving course` at 1,000 are market size,
not local monthly searches. The maps say “distinct monthly demand” without a
geography or source note.

**Recommendation:** print the source and geography next to demand, and discount
or flag global volume for local jobs. A local business’s reachable demand is not
the global keyword volume.

### F11. The drafting note is cut mid-sentence — low

Every board’s “Drafting note” ends mid-word: “on that p”, “weekly brief that”,
“dedicated coaching page is th”, “search engines rewrite snipp”. The cause is the
400-character slice in `lib/research/opportunity-drafting.ts`. An analyst cannot
use a note that stops mid-thought.

**Recommendation:** cut at the last sentence boundary and state that the note was
shortened, or ask the model for a summary under the limit.

### F12. The context-only review overstates zero-volume tails — low

Susi’s taxonomy review lists eleven groups of “N queries / 0 monthly demand name
this place or brand but not its need”. These are mostly zero-volume, unjudged
variants. The wording reads like a missing demand term when there is no demand
to miss.

**Recommendation:** only raise a context-only gap when volume or impressions are
above zero; otherwise put it in the unjudged tail.

## 3. Tenant-by-tenant

### Casamigo — the map is right; the board is premature

- **Demand:** 22 qualified queries, 39 impressions, 0 clicks. The site is
  pre-visibility. The job split is sound.
- **Biggest real opportunities:** Torre 25 (1,600 demand, position 11, one
  impression) — the closest page; Tao Tulum (1,220, position 72); Samsara Tulum
  (1,000, no page, fit unknown); Elementos (320, position 82).
- **First decision:** confirm Samsara and Xaman Ha inventory. If the business
  sells them, create the project pages; if not, remove them from served demand.
- **Before content:** resolve the English/Spanish architecture. English queries
  are pointed at `/es/` pages for Riviera Maya, Tao and the Tulum market. The
  taxonomy review already flags this; the board still proposes Spanish-page work.
- **Technical first:** 122 duplicate titles, 13 broken-link pages, seven missing
  city canonicals. These are the foundations the board’s own priority text asks
  for, but the technical lane is empty.
- **Do not trust:** the ten “closed” rows. Most are churn from the new taxonomy.

### Atelier — best map of the four; fix one target and one offer decision

- **Demand:** 101 qualified queries, 4,066 impressions, 62 clicks (1.52% CTR).
- **Priority is broadly right:** seat/furniture restoration (2,040 demand,
  position 26.2, 208 impressions), abat-jour creation (1,050, position 15.3,
  thin page), lamps (470, position 40.9, 1,100 impressions), abat-jour repair
  (190, position 9.2, 10 clicks), kits (140, position 8.6, 3 clicks).
- **Quick wins:** the repair article and the kit page are already on page one;
  add the missing vocabulary (`réparation`, `réparer`, `fabrication`,
  `fabriquer`) and a quote path. Low effort, high certainty.
- **Fix the target:** the commercial repair job belongs to `/devis`, not the DIY
  article. Keep the two jobs separate.
- **Offer decision:** the abat-jour hub title promises “sur mesure” while the
  offer is unconfirmed; the critique says revise. Confirm the offer before
  rewriting the hub.
- **Technical:** sitemap (50 pages), duplicate titles (45), missing canonicals
  (17), broken links (8). The board has them, but after five content items. Put
  the tag/title pass alongside the content it unblocks.

### Susi — the problem is CTR and coverage, not content volume

- **Real window:** 29,533 impressions, 181 clicks (0.61% CTR), not 11,639 / 38.
- **Top opportunities:** Playa condos (3,520 demand, position 28.1), Tulum homes
  (3,400, position 59.5), Playa rentals (600, position 17.8), Playa investment
  guide (890, position 50.2), Puerto Morelos (690, position 62.8).
- **Diagnosis:** pages exist and rank on pages 3–6 with real impressions but very
  few clicks. The first job is title/H1/need-term/answer-block work, not more
  articles. The board’s top five match that.
- **Coverage:** 1,093 queries / 18,523 impressions / 76 clicks are unjudged.
  Batch-judge the tail before treating the 23 topics as complete.
- **Technical:** the 27-page slow listing template and the 39 broken-link pages
  are conversion and crawl problems on the money pages; move them up from #7–#9.
- **Good exclusion:** `hospital near me` (1,251 impressions) is correctly
  out-of-market; keep it visible and don’t build for it.

### Oceanic — verify the product before writing the course page

- **Visibility:** four impressions, all context; zero demand impressions. The
  site is invisible for the demand set.
- **First action:** sitemap and robots, then a private-coaching service page
  (1,790 demand) and a breathwork section (400). The board’s order is right.
- **Verify the beginner-course job:** the evidence is AIDA 3 plus a guide, not a
  beginner course. If Oceanic does not sell one, mark the job `unknown` or
  `does_not_serve`; the 1,480 demand is then not served demand.
- **Page type:** the course and breathwork topics are owned by blog posts. If the
  business sells coaching, the service page is the owner; the blog is support.
- **Don’t overbuild:** cenote, Playa, Tulum and Mexico have no measured demand;
  keep them as small tests, as the map says.

## 4. Recommended sequence

1. **Fix the trust layer first:** verified closure, site-level totals for the
   gate/headline, technical rows kept in their lane, drafting-note truncation.
2. **Batch the job map for Susi** and merge verdicts; report unjudged tail
   explicitly.
3. **Fix the two semantic errors:** Atelier’s repair target (`/devis`) and
   Oceanic’s beginner-course fit (confirm the offer).
4. **Use the maps, not the closure list:** Casamigo technical foundations first;
   Atelier quick wins plus the seat-restoration job; Susi title/intent/CTR work
   plus the listing template; Oceanic sitemap and the coaching page.
5. Re-run the four boards after the fixes and compare top-five actions, not the
   “closed” counts.

## 5. Bottom line

The job map is the right primitive and it is already removing the kind of demand
that made the old reports wrong. The topic maps are good enough to plan from.
The boards are not: their closure claims are unreliable, their headline numbers
are partial, and two tenant proposals target the wrong page or product. Fix
those before accepting work from this cycle.