/**
 * The market a site actually reaches, measured from Search Console rows it already has.
 *
 * ## Why this exists
 *
 * A site with no stated country cannot buy any evidence: `resolveBundleLocale` throws
 * without one. That is not a business rule, it is a limitation of where we looked —
 * Search Console records a country on every `Keyword` row, it is already stored, and
 * `readQueryPagePerformance` queries it only to discard it (`COUNT(DISTINCT "device" ||
 * '|' || "country")`).
 *
 * Measured 2026-11-25, the split that started this:
 *
 * ```
 * susimacdonald    usa 57%  mex 27%  can 12%
 * casamigo         usa 76%  mex 19%  can  3%
 * alaguillotine    usa 53%  fra 18%  deu 13%  zaf 9%  are 8%   (91 impressions total)
 * atelier          fra 95%  bel  3%
 * ```
 *
 * ## Why a floor on impressions as well as on share
 *
 * A share is a ratio, and a ratio over a handful of rows is noise. Alaguillotine's 53%
 * US is 48 impressions spread over five countries — if that named the market, the bundle
 * would buy US SERPs for a site whose audience is genuinely scattered, and the board
 * would then report "rank for X in the US" off evidence that does not support it. That
 * is the failure the plan's acceptance bar names explicitly.
 *
 * So a market is only measurable when the site has enough observed volume for a share to
 * mean something. Below `MIN_MEASURABLE_IMPRESSIONS` this returns nothing, and the site
 * stays unmeasured — which is honest, and is what pushes it to the tenant step: state
 * the market, or state that it is international.
 *
 * ## What is deliberately not here
 *
 * No TLD inference, no language-to-country table, no city list. `en` names no market and
 * `.com` names no market. The only inputs are stored impressions and their recorded
 * country.
 */

/** A country at or above this share of measured impressions is part of the market. */
export const MARKET_SHARE_FLOOR = 0.25;

/**
 * The most markets one monthly bundle measures.
 *
 * Two, because each market is a separate paid bundle: `capMicros` is 300,000 ($0.30) per
 * locale, so two is $0.60 against a $1 default monthly allowance. Four would be $1.20 and
 * spend the month on one site.
 */
export const MAX_MEASURED_MARKETS = 2;

/**
 * How much of the measured audience the chosen markets must account for.
 *
 * This is the rule that stops a scattered audience being reported as a single market, and
 * it was added after measuring alaguillotine rather than before:
 *
 * ```
 * alaguillotine   136 impressions, 31 countries, top country usa at 35%
 * susimacdonald   68,524 impressions, top uses 57% + mex 27% = 84%
 * ```
 *
 * With only a 25% share floor, alaguillotine's USA clears it — 35% of 136 impressions —
 * and the bundle would buy US SERPs for a site whose audience is spread over 31
 * countries, then report "rank for X in the US" off 48 impressions. That is the failure
 * the plan's acceptance bar names in its own words: *if alaguillotine's answer is "rank
 * for these queries in the US" off 98 impressions, the floor is wrong.*
 *
 * A share floor alone cannot catch it, because 35% is above any floor that would still
 * admit susimacdonald's two-market split. What distinguishes them is **coverage**: the
 * countries we choose must account for most of the audience, or we are measuring a
 * minority and calling it the whole.
 *
 * Half, because measuring more than half of a measured audience is the least a market
 * claim can rest on. Below it the honest answer is that the site has no single market and
 * someone has to state what it is.
 */
export const MARKET_COVERAGE_FLOOR = 0.5;

/**
 * Impressions needed before a share is a signal rather than a rounding.
 *
 * Declared, not tuned to a tenant. 100 is the same order as the plan's own judgement
 * that alaguillotine's 91 impressions "are not a stable market signal anyway"; below it
 * a market claim is a claim about a sample too small to appeal from.
 */
export const MIN_MEASURABLE_IMPRESSIONS = 100;

/**
 * Search Console's country spelling to ISO-3166 alpha-2.
 *
 * Two identifier systems are involved and neither is wrong: Search Console writes
 * `usa`, `gbr`, `mex` (alpha-3, lowercase); `DATAFORSEO_LOCATION_CODES` is keyed by
 * alpha-2 (`US`, `GB`, `MX`). Translating between them is a fact about the codes, not a
 * judgement about the business, so it belongs in code — unlike inferring a country from
 * a TLD or a language, which stays banned.
 *
 * Only the countries in `DATAFORSEO_LOCATION_CODES` matter: an unmapped one cannot be
 * bought, so it is reported rather than guessed at.
 */
const GSC_TO_ALPHA2: Readonly<Record<string, string>> = {
  are: "AE", arg: "AR", aus: "AU", aut: "AT", bel: "BE", bgd: "BD", bra: "BR",
  can: "CA", che: "CH", chl: "CL", col: "CO", cze: "CZ", deu: "DE", dnk: "DK",
  egy: "EG", esp: "ES", fin: "FI", fra: "FR", gbr: "GB", grc: "GR", hkg: "HK",
  hun: "HU", idn: "ID", ind: "IN", irl: "IE", isr: "IL", ita: "IT", jpn: "JP",
  ken: "KE", kor: "KR", mar: "MA", mex: "MX", mys: "MY", nld: "NL", nor: "NO",
  nzl: "NZ", pak: "PK", per: "PE", phl: "PH", pol: "PL", prt: "PT", rou: "RO",
  rus: "RU", sau: "SA", sgp: "SG", swe: "SE", tha: "TH", tur: "TR", twm: "TW",
  ukr: "UA", usa: "US", vnm: "VN", zaf: "ZA",
};

/**
 * The alpha-2 code for a Search Console country, or null when it is unknown here.
 *
 * Returning null rather than the input is deliberate: passing `usa` into a map keyed by
 * `US` yields no location code and a `BundleError` naming the wrong problem, which is how
 * a correct decision looked like a bug the first time this ran.
 */
export function alpha2ForGscCountry(country: string): string | null {
  const key = country.trim().toLowerCase();
  if (key.length === 2) return key.toUpperCase(); // already alpha-2
  return GSC_TO_ALPHA2[key] ?? null;
}

/** One country's share of a site's measured impressions. */
export type CountryShare = {
  /** DataForSEO's spelling of the country, as Search Console records it (`usa`, `mex`). */
  country: string;
  impressions: number;
  /** Fraction of all measured impressions, 0–1. */
  share: number;
};

export type MeasuredMarket = {
  /**
   * The countries that carry the market, strongest first. Empty when the site has no
   * measurable audience, which is a fact about the evidence, not a failure.
   */
  countries: string[];
  /** Every country considered, with its share, so a reader can see the split. */
  shares: CountryShare[];
  /** Total impressions the shares are computed over. */
  impressions: number;
  /**
   * Countries that cleared the floor but were dropped by the cap. Named rather than
   * silently omitted: a dropped market is a decision someone may want to revisit.
   */
  dropped: CountryShare[];
  /**
   * Share of measured impressions the kept countries account for. Reported because it is
   * the number that decided whether the market was nameable at all.
   */
  coverage: number;
  /**
   * Why there is no market, when there is none. Null when `countries` is non-empty.
   * Phrased for a run report, because "no market" has to be readable.
   */
  blockedReason: string | null;
};

/**
 * Decide a site's measured market from its stored country split.
 *
 * Pure: the caller reads the rows, this decides. That keeps the decision testable
 * without a database and keeps the reader honest about what it read.
 */
export function measureMarket(
  rows: { country: string; impressions: number }[],
  opts: {
    shareFloor?: number;
    maxMarkets?: number;
    minImpressions?: number;
    coverageFloor?: number;
  } = {}
): MeasuredMarket {
  const shareFloor = opts.shareFloor ?? MARKET_SHARE_FLOOR;
  const maxMarkets = opts.maxMarkets ?? MAX_MEASURED_MARKETS;
  const minImpressions = opts.minImpressions ?? MIN_MEASURABLE_IMPRESSIONS;
  const coverageFloor = opts.coverageFloor ?? MARKET_COVERAGE_FLOOR;

  // An unknown country is not a country. Search Console writes `''` for rows it could
  // not attribute, and treating that as a market would name "nowhere" as the audience.
  const byCountry = new Map<string, number>();
  for (const row of rows) {
    const country = row.country.trim().toLowerCase();
    if (!country) continue;
    if (!Number.isFinite(row.impressions) || row.impressions <= 0) continue;
    byCountry.set(country, (byCountry.get(country) ?? 0) + row.impressions);
  }

  const impressions = [...byCountry.values()].reduce((sum, value) => sum + value, 0);
  const shares: CountryShare[] = [...byCountry.entries()]
    .map(([country, value]) => ({ country, impressions: value, share: impressions > 0 ? value / impressions : 0 }))
    // Strongest first; ties broken by the country code so the result is deterministic
    // rather than dependent on Map insertion order.
    .sort((a, b) => b.impressions - a.impressions || a.country.localeCompare(b.country));

  if (impressions === 0) {
    return {
      countries: [],
      shares: [],
      impressions: 0,
      dropped: [],
      coverage: 0,
      blockedReason: "no first-party impressions carry a country, so the audience cannot be measured",
    };
  }

  if (impressions < minImpressions) {
    return {
      countries: [],
      shares,
      impressions,
      dropped: [],
      coverage: 0,
      // The honest reason, with the number: this is what stops a small split from
      // becoming a market claim.
      blockedReason: `only ${impressions} impressions across ${shares.length} countries, below the ${minImpressions} needed for a share to be a market signal`,
    };
  }

  const qualifying = shares.filter((entry) => entry.share >= shareFloor);
  if (qualifying.length === 0) {
    return {
      countries: [],
      shares,
      impressions,
      dropped: [],
      coverage: 0,
      blockedReason: `no country carries at least ${Math.round(shareFloor * 100)}% of ${impressions} measured impressions; the audience is too scattered to name a market`,
    };
  }

  const kept = qualifying.slice(0, maxMarkets);
  const coverage = kept.reduce((sum, entry) => sum + entry.share, 0);

  // Coverage, not just share. A country above the floor can still be a minority of the
  // audience; buying it then reports a fraction as the whole.
  if (coverage < coverageFloor) {
    return {
      countries: [],
      shares,
      impressions,
      dropped: qualifying.slice(maxMarkets),
      coverage,
      blockedReason: `${Math.round(shareFloor * 100)}% share floor leaves ${kept
        .map((entry) => entry.country)
        .join(" and ")} covering only ${Math.round(coverage * 100)}% of ${impressions} measured impressions across ${
        shares.length
      } countries; the audience is too scattered to name a market, so state one instead`,
    };
  }

  return {
    countries: kept.map((entry) => entry.country),
    shares,
    impressions,
    dropped: qualifying.slice(maxMarkets),
    coverage,
    blockedReason: null,
  };
}

/** The country split a reader produces, before it is aggregated. */
export type CountryImpressions = { country: string; impressions: number };

/**
 * Aggregate raw `Keyword` rows into a country split.
 *
 * Kept separate from the database read so both are testable: the caller owns the query,
 * this owns the arithmetic. A reader that both queried and decided would be the place a
 * country quietly got dropped.
 */
export function countrySplit(rows: { country: string | null; impressions: number | null }[]): CountryImpressions[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const country = (row.country ?? "").trim();
    if (!country) continue;
    const impressions = row.impressions ?? 0;
    if (!Number.isFinite(impressions) || impressions <= 0) continue;
    totals.set(country, (totals.get(country) ?? 0) + impressions);
  }
  return [...totals].map(([country, impressions]) => ({ country, impressions }));
}
