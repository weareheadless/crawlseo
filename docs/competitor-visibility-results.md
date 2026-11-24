# Competitor visibility: what each issue delivers

Companion to [the plan](competitive-visibility-plan.md). One block per issue, in
plain SEO terms: what breaks today, what the ticket makes true, and how you would
know it worked without reading the code.

---

## CMP-001 — Store SERP snapshots that name real ranking domains

**Today.** Every SERP sample we buy is mostly Google's own redirect wrappers.
247 of the 340 organic URLs ever stored are `google.com/goto?url=…`; the newest
sample was 6 of 6 wrappers with `domain: "google.com"`. The collector then asks
"does our domain appear in these URLs", which can never match a wrapper, and
concludes "we don't rank, competitors cover it" on **83 of 85** samples —
including queries where we rank first.

**What that costs you.** Three of your content-gap opportunities on Susi, ten on
casamigo, eleven on Atelier are built on that false conclusion. Work gets queued
against gaps that do not exist, and every real rank we hold from a sampled SERP
is invisible.

**What the ticket makes true.** A snapshot is a list of real domains at real
positions. If we rank, the position is a number. If we genuinely are absent, the
snapshot says so — and an all-wrapper response is recorded as *unobserved*, never
as coverage.

**How you'd see it.** Open any opportunity sourced from a SERP: it names the
domain sitting above us. Compare with the live SERP yourself; it matches.

---

## CMP-002 — File every opportunity under the cluster it serves

**Today.** 645 of 691 opportunities on Susi are attached to no topic. The cluster
page therefore says "no opportunity in this cluster yet" while 22 live
opportunities sit on the board next door. A cluster cannot be worked as a
cluster, and the cluster-play detector can never fire.

**What the ticket makes true.** Every detected opportunity lands in the topic its
query belongs to, resolved from the taxonomy a human already approved. Queries
with no approved topic stay visibly unclustered — nothing is guessed.

**How you'd see it.** Pick a cluster: it lists the work that serves it, and the
demand map's "in a cluster" and "not yet clustered" tiles add up to the board
total.

---

## CMP-003 — Measure who ranks for our queries, per cluster

**Today.** `competitor_rank` holds **zero rows** on all eight sites. No competitor
has ever been measured. The demand map computes "competitor strength" from data
that does not exist, so it always shows none, and cluster discovery can never say
"these queries belong to someone else".

**What the ticket makes true.** For each of our queries, the domains that rank
above us, at what position, from the sample we already paid for. A leaderboard
per cluster: who ranks, on how many of our queries, at what average position, and
which queries they hold that we do not.

**How you'd see it.** A cluster page that names the domains beating you and the
specific queries they beat you on — not "competition: medium".

---

## CMP-004 — Track a keyword grid weekly and chart its position history

**Today.** Nothing is tracked: `tracked` is false on all 540 clusters. The
rank-history endpoint exists, is correct, and no screen calls it — there is no
rank-over-time chart in the product. Meanwhile a year of daily position history
sits unread in the database, for free.

**Why not sample the SERP weekly.** Measured on our own data: a week apart, a
query's real move is 0.8 positions, while one day's own average position is
uncertain by 1.1. Weekly SERP buying would report noise. Bucketing the free daily
history into weeks clears it — the real weekly move is 3.0 positions.

**What the ticket makes true.** A declared grid per cluster (the cluster head plus
its strongest members), a weekly position line built from history we already own
at **no cost**, and the monthly sampled SERP positions overlaid as a separate,
labelled series — never merged. One week of history shows "no trend yet", not a
flat line. The monthly sample runs only on queries we act on: 24–28 per site,
about **6 cents**.

**How you'd see it.** You can watch a query move week to week, know which source
each point came from, and pay essentially nothing for the trend.

---

## CMP-005 — Measure the volume of every tracked query

**Today.** On Susi, 53 of 1,226 clustered queries have a measured volume. The
consequence is not cosmetic: 119 striking-distance opportunities are parked, 110
of them below threshold, **median score 1.0**.

It is tempting to say they lack a volume. They mostly do not. 103 of the 144
parked rows are already `measured`, with a median reach of 17 impressions — above
the floor. They score zero because the play targets the position it already
holds: `targetPosition == currentPosition` on all 103, current CTR 0 on 99, and
the upside is `observed × max(0, target − current)`, which is zero by arithmetic.
Only 41 rows are genuinely missing reach. Fixing the target is free and moves a
hundred rows; buying volume moves the 41.

Atelier: 38 of 184. Casamigo: 265 — and casamigo is the site with a live board.

**What the ticket makes true.** Every tracked query carries a measured volume with
its source and date, so an opportunity states its click upside ("+340 clicks/month
at position 3") instead of being parked. Queries that could not be measured say
"not measured" — no invented number.

**How you'd see it.** The board orders by realistic upside and the parked pile
shrinks because the work became measurable, not because a threshold was lowered.

---

## CMP-006 — Name the pages above us and the specific deficit on ours

**Today.** The "how we win it" half of every opportunity is a constant. The scorer
gives every opportunity a page-strength of 0.5 and no authority gap — numbers
nobody measured — and the content-gap summary names no competitor and no page. You
cannot hand it to a writer.

**What the ticket makes true.** For each opportunity: the three pages ranking
above us, and for each one what it has that ours does not — word count, headings,
schema type, freshness, internal links. A one-line deficit on the board, a diff
table on the detail page. When nothing measurable differs, it says so.

**How you'd see it.** "interieurlumiere.com ranks 2 for 'kit lampe' with 1,840
words and Product schema; our page has 420 words and no schema." A writer starts
from that without opening a browser.

---

## CMP-007 — Turn the backlink gap into a list of link targets

**Today.** The backlink detector cannot fire. It looks for a metric —
`referringDomainGap` — that no code writes, and the database holds 2 backlink
records in total, both about our own domain. So there has never been a link
opportunity, only a link section.

**What the ticket makes true.** For a query worth winning: the domains linking to
the pages above us and not to us, with their metrics, plus the competitor URL they
cite. O9 fires with a real number and produces a task carrying the target list.

**How you'd see it.** A link task you can act on Monday morning without opening a
third-party tool.

---

## CMP-008 — Compute measured share of voice per cluster

**Today.** "Share of voice" is `1 − (ourBest − 1) / 19` — a restatement of our own
best position, with no competitor in it, and `share_of_voice` evidence has zero
rows. `competitorStrength` renders 0 when there is no data, which reads as "no
competition" rather than "unknown".

**What the ticket makes true.** A weekly, measured share of voice per cluster:
each domain credited `ctrAtPosition(rank)` across the tracked queries, our share
against each named competitor, the queries we lose and to whom. A cluster with no
sample reads *unobserved* — never 0 %.

**How you'd see it.** One number you can put in a client report, and a status per
cluster: winning, contending, losing. Winning is defined: top share for four
consecutive weeks and at least one measured delivered win.

---

## CMP-009 — Prove each delivered task moved the position it promised

**Today.** 17 tasks, **zero** outcome measurements. Nothing the system ships is
ever checked, so every claim about effectiveness is untested and the product
cannot answer "did it work".

**What the ticket makes true.** A baseline captured at acceptance (our position
and the competitor URL ahead), a measure 28 days after delivery: before → after,
the competitor's movement on the same query, and a verdict. A win is only recorded
after a human confirms; the system never marks its own work as won.

**How you'd see it.** Per delivered item: what moved, by how much, against whom,
over which dates, with the honest limitation that seasonality and algorithm
changes are not excluded. And the cluster scoreboard counts measured wins against
delivered work.

---

## CMP-010 — A "position declined" opportunity means the query declined

**Today.** The detector that reports a ranking decline compares two nearly
identical windows. Ranks are stored as rolling 28-day windows re-projected every
day, and the selector picks "the second-newest window" — which is yesterday's
window, not last month's. The two spans share **27 of 28 days**. On the
best-populated site, 51 % of the compared pairs differ by exactly zero and the
detector fires **once**; against the real previous window it fires **43 times**.

**What that costs you.** Real declines — the ones you would want to act on
before a quarter ends — are invisible, because a genuine 28-day fall is averaged
away inside a window that is 96 % the same data.

**What the ticket makes true.** The detector compares the two windows the
evidence was written with (`current` vs `previous`), refuses a comparison whose
windows overlap, states both dates on the opportunity, and corroborates with the
free weekly series. A decline you see on the board is a decline.

**How you'd see it.** A "position decline" card names two dates four weeks apart
and the movement between them, and you can check it in Search Console.

---

## CMP-012 — Priority should reflect who we are fighting

**Today.** Every opportunity carries a "chance we win this" number, and that
number is three constants. `authorityGap` is literally `0.5` on 70 of 75 live
opportunities; `pageStrength` and `serpCompetition` are `0.5` on **all 75**. So the
board orders work by volume, rank distance and effort — and nothing else.

**What that costs you.** A query where the top three results are national brands
sorts exactly level with one where a forum post is third, at the same volume. That
comparison is the job. The product currently performs it by writing `0.5` in three
places, which reads like a measured fair fight and is not one.

**The annoying part.** The data already exists. Keyword difficulty is stored for
606 of 708 keyword rows, and 47 of the 116 queries the live board actually cites
already have it. Nothing in the scoring path ever reads it. This is a wiring fix
plus an honest `null`, not a new data purchase.

**How you'd see it.** Two opportunities with the same volume and the same position
stop scoring the same when one has a DA-70 incumbent. And a row where the inputs
are assumed rather than measured says so, instead of looking confident.

---

## CMP-011 — Nothing on the board can be produced by nothing

**Today.** The layer knows the *names* of nineteen things it can store and
nothing about them — not what they must contain, not who writes them, not whether
what they mean is a single moment or a rolling average. So a detector can be built
against a number nobody produces and the build stays green. Eight of the nineteen
are broken today: three are read and never written, one is written and never
read, four are dead.

**What that costs you.** Not "a technical debt item". It costs exactly what this
conversation cost: every time somebody reads the board, they find one more number
that is silently zero. O9 has never fired because the number it reads is never
written. O12 has never fired while 87 vitals reports sit in a table nobody
projects. O11 reports declines that are the same window compared with itself.

**What the ticket makes true.** Two guarantees, both enforced:
every number on the board is produced by something that declares it, and every
opportunity can be checked line by line — does it name a page, does that page
return 200, does it name the query, is the number measured or is it a
hypothesis you should not trust yet.

**How you'd see it.** A build that goes red the moment a reader loses its writer,
and an audit that prints, per site, exactly which cards on the board you cannot
act on and why. Today it would print: **0 of 75 live opportunities carry a
measured or estimated impact — 71 are unmeasured hypotheses**; 2 point at pages
the crawl never saw, 9 on one site alone.

---

## The order that matters

CMP-001 and CMP-002 first: without attributable snapshots and attached
opportunities, everything after measures the wrong thing. CMP-012 belongs with
CMP-005, because buying volume for queries the board still ranks flat is spending
money to sort a list badly. **CMP-011 lands with
them**, because it is the guard that stops the next ten findings from being
discovered one conversation at a time — and it is what fixes CMP-009 and CMP-010
rather than sitting beside them. CMP-010 sits with them
rather than at the end: it is one selector reading evidence that is already
correct, it needs no data bought, and until it lands the board cannot report a
decline at all. Then CMP-003 and CMP-004, which give the board its memory and its
opponent. CMP-005 unblocks the
parked work that is already real. CMP-006 and CMP-007 make each opportunity
actionable. CMP-008 and CMP-009 close the loop so the next cycle starts from
measured ground.

The end state per cluster is four numbers a client understands — coverage,
measured share of voice, a detected decline, and a measured win — each traceable
to a stored sample.
