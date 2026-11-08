# SEO review — 2026-11 one-pass run, as shown in the app

Reviewed 2026-11-08 against the deployed UI (`crawlseo.helloada.app`), the
stored job maps, topic maps and opportunity boards for the four tenants. This
is a judgement on the output of the one-pass pipeline, not a new research run.

**Verdict.** The one-pass model produces maps an owner can act on. Demand is
judged, not word-matched; every topic carries the model's reason; and the two
invisible sites are correctly pushed to foundations. The weaknesses are now in
presentation and scoring, not in what the topics mean: one scoring formula
still turns market volume into fantasy clicks, and the legacy funnel sources
still sit next to the model's map in the same UI.

## What the UI shows

| Tenant | Window | Topics | Judged demand | Deferred | Board |
|---|---|---:|---:|---:|---:|
| Casamigo | 39 impressions, 0 clicks | 14 | 21 | 0 | 17 |
| Atelier | 4,066 impressions, 62 clicks | 13 | 116 | 0 | 17 |
| Susi | 29,533 impressions, 181 clicks | 24 | 211 | 914 | 26 |
| Oceanic | 4 impressions, 0 clicks | 13 | 42 | 0 | 13 |

The demand map renders one row per modelled topic with its intent, relevance,
the model's rationale, membership count, ranking coverage, best position and
open proposals. That is the right shape: the map explains the topic instead of
listing keywords.

## Tenant judgement

### Casamigo — fix the site, then the Spanish money page

- Only 21 of 274 queries are judged demand; the other 253 are context, noise or
  out-of-market. That is the correct answer for a site with 39 impressions.
- The largest structural hole is `Propiedades en venta en Playa del Carmen`:
  five phrasings, about 130 monthly searches, zero impressions. The site has no
  Spanish money page for it.
- Tao Tulum is split across five variants between positions 53 and 83 against
  about 1,220 searches; one English page with the variants in title, H1 and
  opening copy is a cheap consolidation win.
- Torre 25 carries the largest brand demand (about 1,600) and already sits at
  position 11 on one impression; the property page should hold page one.
- Riviera Maya market (210 searches, position 24) is the best informational
  foothold and has no article.
- The board correctly holds all content behind five technical foundations
  (H1s, broken links, canonicals, duplicate titles, schema). Do those first.
- Xaman Ha has `unknown` fit and no page; do not build it until the owner
  confirms the listing exists.

### Atelier — the healthiest tenant and the most decision-ready board

- 116 of 169 queries are judged demand, with 4,066 impressions and 62 clicks.
- The click estimates are believable because measured reach exists: sièges and
  fauteuils about 10 clicks/month at position 25.8, pagode shades about 7 at
  14.6, the DIY kit about 5.6 at 8.6.
- The map's own diagnosis is vocabulary, not demand: `fauteuil` and `tapissier`
  are missing from the sièges page, `luminaire artisanal` from `/lampes`
  (position 40.5), and `fabrication` from the kit product page.
- Technical work is real and specific: 59 duplicate descriptions, a missing
  canonical on delivery pages, broken links on the Baladeuse product page.
- Work the top six, in order. Nothing in the board needs a second opinion.

### Susi — the strongest demand and the most misleading first row

- 1,164 visible queries, only 250 judged; 914 are deferred (6,275 impressions,
  30 clicks). The deferred examples include `homes for sale in cozumel mexico`
  and `apartments for rent in playa del carmen mexico`, so the board is
  explicitly incomplete rather than exhaustive.
- The 24 topics are the right ones: Playa del Carmen condos (24 queries), named
  developments (23), rentals (16), Puerto Morelos condos (14), Tulum villas
  (10), plus investment, financing, hospitals and market/regulation context.
- Priorities 2–10 are sound: Playa condos at 27.4, Tulum villas at 65.3,
  rentals at 604 words, Cozumel at 59.7, Puerto Morelos hubs on page three.
- The board now starts with the named-development directory (≈25 clicks from
  1,681 impressions at position 16.5), the hospital guide (≈24 from 1,701
  impressions at 6.5) and the rentals page (≈17 from 1,107 at 18.7). Those
  estimates use measured impressions; market demand is shown next to them.
  Before the scoring fix the hospital row read ≈17,081 clicks because market
  volume was multiplied into the estimate.
- Hospital content is relocation support, not the first commercial build; the
  named-development directory and the rentals page are the buyer jobs.

### Oceanic — foundations only, and the map already says why

- 42 of 85 queries are judged demand, with 4 impressions and no clicks.
- The 13 topics read like the service catalogue: training and coaching (1,870),
  depth training (1,600), course (1,390), Playa del Carmen local (730),
  breathwork (400), cenotes and Tulum (90 each), AIDA (30), line training (10).
- The gate holds every content proposal, correctly. Ship schema, the sitemap and
  unique titles on the two pages sharing the homepage title first.
- Then build the training hub, not the AIDA or line pages: the demand exists for
  coaching and depth, and the current course guide is a blog post, not a course
  page.

## UI and data findings

All six were fixed structurally after the review; the app was redeployed and the
stored data repaired.

1. **A funnel refresh retired the model's map.** Minutes after deploy, lexical
   cluster discovery re-clustered the same evidence and superseded 10 of
   Casamigo's 14 topics. Discovery now yields to a project that already has
   topic-map clusters, retires its own untracked legacy rows, and a model topic
   that drops out of the map without members is retired. Data repaired to
   14 / 13 / 24 / 13 active clusters.
2. **A detector parked the one-pass board.** `retireStaleDetected` parked every
   detected row of a type it did not re-produce, including another producer's
   proposals. Retirement is now scoped to the detector's own `detectedBy`.
3. **Legacy sources crowded the counts.** For a project with topic-map clusters,
   `refreshFunnelForSite` now skips the legacy detectors and parks their detected
   rows with a stated reason. Human decisions are untouched. Open opportunities
   fell to 19 / 19 / 26 / 13 and unclustered to 3 / 4 / 4 / 0.
4. **Re-proposed rows that were closed stayed closed.** The old diff rule had
   closed 26 rows per project with `parkReason: "superseded by refreshed
   proposal"` and no decision by a person. Those were migrated to `parked` and
   the current board reopened. Going forward closure is untouched, and a
   re-proposal of a verified closure is reported on the board as "proposed again
   after a verified closure — check for regression".
5. **The run page hid the map's numbers.** A topic-map run now shows topics,
   judged demand, deferred count and weight, not-demand and unmapped counts, and
   the site window. The run date uses `startedAt`, not `createdAt`.
6. **Cluster summaries are mixed.** New map builds use the model's reason for the
   topic; the counts and coverage are shown as facts beside it. Stored rows whose
   summary was a lexical "N queries sharing the phrase" were repaired.

## What the review changes

- Casamigo and Oceanic remain foundations-first; the one-pass map strengthens
  that conclusion rather than overturning it.
- Atelier's board is ready to work as drafted.
- Susi's board is now ordered by measured reach: the development directory,
  hospitals and rentals lead. Work them in that order.
- The next cycle's first job is the deferred Susi tail, not new topic
  discovery. 914 queries with real buyer language are still unjudged.