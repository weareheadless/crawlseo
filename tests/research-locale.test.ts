import { describe, expect, it } from "vitest";

import { countryFromText, tldSignals } from "@/lib/site/context";

/**
 * The country used to be resolved by a function that answered "US" whenever it
 * did not recognise the market. A wrong default is worse than no answer: it sends
 * French research to the US edition and nobody notices. The matcher now returns
 * null and the site context records where the value came from.
 */
describe("country from market text", () => {
  it("recognises the markets we have seen", () => {
    expect(countryFromText("France, Normandie")).toBe("FR");
    expect(countryFromText("Mexico")).toBe("MX");
    expect(countryFromText("Spain")).toBe("ES");
    expect(countryFromText("United Kingdom")).toBe("GB");
    expect(countryFromText("Deutschland")).toBe("DE");
  });

  it("returns null instead of guessing", () => {
    expect(countryFromText("Global")).toBeNull();
    expect(countryFromText("")).toBeNull();
    expect(countryFromText(null)).toBeNull();
  });
});

describe("domain signals", () => {
  it("reads a country TLD", () => {
    expect(tldSignals("atelier-harmonie.fr")).toEqual({ country: "FR", language: "fr" });
    expect(tldSignals("example.de")).toEqual({ country: "DE", language: "de" });
  });

  it("reads a second-level TLD", () => {
    expect(tldSignals("shop.example.co.uk")).toEqual({ country: "GB", language: "en" });
  });

  it("does not invent a country for a generic TLD", () => {
    // A .com says nothing about the market, so it yields nothing.
    expect(tldSignals("example.com")).toEqual({ country: null, language: null });
    expect(tldSignals("example.io")).toEqual({ country: null, language: null });
    expect(tldSignals(null)).toEqual({ country: null, language: null });
  });
});
