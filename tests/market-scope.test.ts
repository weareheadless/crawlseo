import { describe, expect, it } from "vitest";

import {
  marketScopeForOffer,
  marketScopeForTopic,
  parseMarketScope,
} from "@/lib/site/market-scope";

describe("tenant market scope", () => {
  it("parses offer scopes and bounds unknown values", () => {
    const config = parseMarketScope({
      default: "local",
      offers: [
        { offer: "Restauration de siège", scope: "local", markets: ["Normandie"] },
        { offer: "Lampes & luminaires", scope: "international", markets: ["France", "Europe"], notes: "online" },
        { offer: "Lampes & luminaires", scope: "national", markets: ["ignored duplicate"] },
        { offer: "", scope: "international", markets: [] },
      ],
    });
    expect(config.default).toBe("local");
    expect(config.offers).toHaveLength(2);
    expect(marketScopeForOffer(config, "lampes & luminaires")).toMatchObject({
      scope: "international",
      markets: ["France", "Europe"],
    });
  });

  it("falls back to the tenant default when an offer has no scope", () => {
    const config = parseMarketScope({ default: "national", offers: [] });
    expect(marketScopeForTopic(config, "Restauration de siège")).toEqual({
      scope: "national",
      markets: [],
      source: "default",
    });
  });

  it("uses the offer scope when it exists", () => {
    const config = parseMarketScope({
      default: "local",
      offers: [{ offer: "Lampes & luminaires", scope: "international", markets: ["France", "Europe"] }],
    });
    expect(marketScopeForTopic(config, "Lampes & luminaires")).toEqual({
      scope: "international",
      markets: ["France", "Europe"],
      source: "offer",
    });
  });
});
