/**
 * Tenant-level market scope.
 *
 * A site can serve more than one market: a Normandy upholstery service is local,
 * while handmade lamps can be sold nationally or internationally. The scope is
 * a tenant setting, not a code branch for Atelier. It is stored in the existing
 * `SiteProfile.constraints` JSON and edited from the business settings page.
 */

export type MarketScopeLevel = "local" | "national" | "international";

export type OfferMarketScope = {
  /** The offer/service name as the owner writes it. */
  offer: string;
  scope: MarketScopeLevel;
  /** Places or markets the offer serves, e.g. ["Normandie"] or ["France", "Europe"]. */
  markets: string[];
  notes?: string;
};

export type MarketScopeConfig = {
  /** Used when an offer has no explicit scope. */
  default: MarketScopeLevel;
  offers: OfferMarketScope[];
};

export const MARKET_SCOPE_LEVELS: readonly MarketScopeLevel[] = ["local", "national", "international"];

export const DEFAULT_MARKET_SCOPE: MarketScopeConfig = { default: "local", offers: [] };

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function scopeLevel(value: unknown, fallback: MarketScopeLevel): MarketScopeLevel {
  return typeof value === "string" && MARKET_SCOPE_LEVELS.includes(value as MarketScopeLevel)
    ? (value as MarketScopeLevel)
    : fallback;
}

/** Parse and bound the JSON stored in `SiteProfile.constraints.marketScope`. */
export function parseMarketScope(value: unknown): MarketScopeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_MARKET_SCOPE };
  const row = value as Record<string, unknown>;
  const defaultScope = scopeLevel(row.default, "local");
  const offers: OfferMarketScope[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(row.offers) ? row.offers.slice(0, 24) : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const offer = text(entry.offer, 120);
    if (!offer) continue;
    const key = offer.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const markets = Array.isArray(entry.markets)
      ? entry.markets
          .filter((market): market is string => typeof market === "string" && market.trim().length > 0)
          .map((market) => market.trim().slice(0, 80))
          .slice(0, 12)
      : [];
    offers.push({
      offer,
      scope: scopeLevel(entry.scope, defaultScope),
      markets,
      ...(text(entry.notes, 300) ? { notes: text(entry.notes, 300) as string } : {}),
    });
  }
  return { default: defaultScope, offers };
}

export function marketScopeForOffer(config: MarketScopeConfig, offer: string): OfferMarketScope | null {
  const key = offer.trim().toLowerCase();
  if (!key) return null;
  return config.offers.find((entry) => entry.offer.trim().toLowerCase() === key) ?? null;
}

export function marketScopeForTopic(
  config: MarketScopeConfig,
  offerKey: string
): { scope: MarketScopeLevel; markets: string[]; source: "offer" | "default" } {
  const match = marketScopeForOffer(config, offerKey);
  if (match) return { scope: match.scope, markets: match.markets, source: "offer" };
  return { scope: config.default, markets: [], source: "default" };
}

/** Stable JSON for storage; strips unknown keys and bounds the list. */
export function normalizeMarketScope(value: unknown): MarketScopeConfig {
  return parseMarketScope(value);
}
