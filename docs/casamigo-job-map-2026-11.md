# Casamigo job map — 2026-11 (pilot)

**Status: pilot artifact.** Part of the
[intent and job map workstream](seo-intent-job-map-plan.md). It is an internal
analysis, not a client deliverable and not an approval gate. The row-level
classification is in [the CSV](casamigo-job-map-2026-11.csv).

The production rule will be the review's per-query verdict. The rules in this pilot
are an analyst's one-off and must not be copied into `lib/`.

## What this asks

The 2026-11 map reported **534,380** monthly demand for the Tulum topic and **8,040**
for advisory. This document asks what job each measured query serves, and whether the
business can serve it.

## The jobs the business serves

| # | Job | Statement | Who · stage · language | Business fit | Page | Qualified demand |
|---|---|---|---|---|---:|---|
| 1 | Buy or invest in a property | "I want a condo, house or land in Playa, Tulum, Cancún, Puerto Morelos, Cozumel or Bacalar." | buyer/investor · buy · en/es | serves (listings) | `/es/properties`, city pages | 860 |
| 2 | Evaluate a named project | "I want to check this specific development before I commit." | buyer · compare/buy · en/es | serves where represented; unknown for some | project pages, mostly missing | 4,450 |
| 3 | Understand the market | "I want prices, ROI and market data before I buy." | investor · research · en/es | serves (market intelligence) | `/es/weekly-brief`, `/es` | 20 |
| 4 | Hire a local advisor | "I want someone local to guide the purchase." | buyer · compare/buy · en/es | serves (advisory) | `/about-us` | 0 |
| 5 | Brand | "I am looking for Casamigo." | any · en/es | serves | `/` | 0 volume |
| 6 | English-language buyer | "I want a Riviera Maya property." | US/CA buyer · research/buy · en | serves; no page or term | none | 210 |

### Job 1 — Buy or invest in a property (860)

`terrenos en cancun amistad bienes raíces` (720), `propiedades en venta en playa del
carmen` and its two word-order variants (40 each), `condominios de lujo en cancun`
(10), `condominios de lujo playa del carmen` (10).

Thin demand, and the pages exist. The job is covered; it is not earning clicks.

### Job 2 — Evaluate a named project (4,450)

`torre 25` (1,600), `samsara tulum` (1,000), `tao tulum` (1,000), `elementos cozumel`
(320), `tao tulum mexico` (210), `musa del puerto` (170), `distrito cozumel` (70),
`los amigos tulum` (70), plus `tao condos tulum mexico`, `tao condo tulum`, `tao lofts
tulum`, `ikuku for sale`, `xaman ha condo`, `punta playa condos` with no measured
volume.

This is the real Tulum demand: buyers checking a specific building. It is not the
534k market topic. Several projects have no page and their service-area fit must be
confirmed before a page is proposed.

### Job 3 — Understand the market (20)

`tulum real estate market` (10), `playa del carmen real estate market` (10). Measured
but tiny. The offer is real; the demand is not yet.

### Job 4 — Hire a local advisor (0)

The 8,040 reported for this topic came from `inmobiliaria cerca de mi` and
`bienes raíces cerca de mí` — local intent with no place. They could come from
anywhere in Mexico. They are not evidence of Riviera Maya advisory demand.

### Job 5 — Brand (0 volume)

`casa migo` (3 impressions), `casamigo homes`, `casamigo residence`. The brand is
split across spellings; there is no volume to defend yet.

### Job 6 — English-language buyer (210)

`mayan riviera real estate` (7 impressions, 210 volume). The business sells to US/CA
buyers, the query is English, and no page or need term covers it. This is a gap, not
unmapped noise.

## What is not this business's job

| Bucket | Queries | Volume | What it is |
|---|---:|---:|---|
| Noise — different job or meaning | 38 | 2,132,950 | `casas de cambio`, `casas de empeños`, physics `propiedades de la materia`, `mario casas`, `casas de los famosos`, `casas de jengibre` |
| Context — category, no market | 41 | 933,030 | bare `casas`, `departamentos`, `propiedades`, `condominios`, `bienes raíces` |
| Out of market | 91 | 635,260 | CDMX, Guadalajara, Monterrey, Querétaro, Tijuana, Puebla, Miami |
| Context — local intent, no place | 7 | 112,690 | `casas cerca de mi`, `departamentos cerca de mi`, `condominios cerca de mi`, `inmobiliaria cerca de mi` |
| Noise — portal or competitor | 25 | 41,810 | `inmuebles24`, Century 21, IAD, Kiva, other agencies |
| Context — informational | 45 | 14,960 | `qué es bienes raíces`, `ley de condominios`, generic investment terms |

## What the numbers become

| Topic | Reported demand | Qualified demand | What the rest was |
|---|---:|---:|---|
| Tulum market and projects | 534,380 | 4,450 | 5 currency/pawnshop queries + 2 near-me queries |
| Riviera Maya property listings | 7,230 | 860 | `condominios cerca de mi` (6,600), near-me, generic terms |
| Riviera Maya advisory | 8,040 | 0 | near-me queries with no place |
| Market intelligence | 20 | 20 | — |
| Brand | 0 | 0 | — |
| **Total** | **549,670** | **5,540** | **99% of the reported demand is not this business's job** |

Topic demand is not additive: a query can belong to more than one topic, so the
reported total double-counts some rows. The qualified total is per unique query.

## Gaps this exposes

- **English demand has no page.** 210 monthly searches from the audience the business
  says it serves, with no English term or page.
- **Project pages are missing.** Torre 25, Musa del Puerto, Ikuku, Xaman Ha and Punta
  Playa have demand or impressions and no owner page. Confirm each is in the service
  area and represented before proposing one.
- **Advisory has no qualified demand.** The 8,040 was near-me traffic, not Riviera
  Maya intent. The job may still be worth a page for conversion, but not as an SEO
  priority.
- **Playa property demand is thin and covered.** 860 searches, pages exist, no clicks.
  This is a page-execution problem, not a content gap.

## Check

274 unique queries; all assigned; 0 unclassified. The CSV records the row-level
assignment. Buckets cover every unique query; volumes are per query and are not
additive across topics.

The classification here is an analyst's one-off. The production rule is the review's
per-query verdict (`demand` / `context` / `noise` / out-of-market), applied by code.
No phrase list from this document goes into `lib/`.

## What this changes

- Tulum splits into **evaluate a project** (4,450) and **buy a property** (860); it is
  no longer one 534k topic.
- Advisory loses its 8,040. It needs a place-qualified need or an explicit decision
  that near-me traffic is a separate audience.
- Need terms must be intent phrases: `casas en venta`, not `casas`; `departamentos en
  venta`, not `departamentos`.
- The English query becomes a job with no page, not an unmapped row.

## Next

Generalize the format to Atelier, Susi and Oceanic. Then wire the per-query verdict
into the review and the arithmetic, as described in the workstream plan.
