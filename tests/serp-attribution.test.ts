import { describe, expect, it } from "vitest";

import {
  attributableHost,
  isAttributableResult,
  isSiteResult,
  normalizeSiteDomain,
  resolveRankedResult,
  sameSite,
} from "@/lib/dataforseo/serp-attribution";

/**
 * CMP-001: a SERP item must be attributable to a real ranking page before any
 * position is computed from it. These are the predicates the collector and the
 * research providers now share.
 */
describe("SERP attribution", () => {
  describe("attributableHost", () => {
    it("returns the bare host without www", () => {
      expect(attributableHost("https://www.example.com/page")).toBe("example.com");
      expect(attributableHost("http://example.com")).toBe("example.com");
      expect(attributableHost("https://shop.example.com/x")).toBe("shop.example.com");
    });

    it("returns empty for an unparseable or missing URL", () => {
      expect(attributableHost("")).toBe("");
      expect(attributableHost(null)).toBe("");
      expect(attributableHost(undefined)).toBe("");
      expect(attributableHost("not a url")).toBe("");
    });
  });

  describe("isAttributableResult", () => {
    it("rejects Google redirect wrappers", () => {
      expect(isAttributableResult("https://www.google.com/goto?url=https://real.test/x")).toBe(false);
      expect(isAttributableResult("https://google.com/searchviewer/main")).toBe(false);
      expect(isAttributableResult("https://www.google.co.uk/search?q=x")).toBe(false);
    });

    it("rejects wrapper hosts even when the declared domain disagrees", () => {
      // The URL's own host wins: a wrapper carrying a real domain is still a wrapper.
      expect(isAttributableResult("https://www.google.com/goto?url=x", "real.test")).toBe(false);
    });

    it("rejects googleusercontent hosts", () => {
      expect(isAttributableResult("https://ci3.googleusercontent.com/proxy/x")).toBe(false);
    });

    it("accepts a real result", () => {
      expect(isAttributableResult("https://competitor.test/service")).toBe(true);
      expect(isAttributableResult("https://www.competitor.test/")).toBe(true);
    });

    it("falls back to the declared domain when the URL cannot be parsed", () => {
      expect(isAttributableResult("", "competitor.test")).toBe(true);
      expect(isAttributableResult("", "google.com")).toBe(false);
    });

    it("rejects when neither a URL host nor a domain is present", () => {
      expect(isAttributableResult("", "")).toBe(false);
      expect(isAttributableResult(null, null)).toBe(false);
    });
  });

  describe("normalizeSiteDomain", () => {
    it("accepts a bare domain, a www variant, and a full URL", () => {
      expect(normalizeSiteDomain("example.com")).toBe("example.com");
      expect(normalizeSiteDomain("www.example.com")).toBe("example.com");
      expect(normalizeSiteDomain("https://www.example.com/page")).toBe("example.com");
      expect(normalizeSiteDomain("EXAMPLE.com")).toBe("example.com");
    });

    it("returns empty for an empty value", () => {
      expect(normalizeSiteDomain("")).toBe("");
      expect(normalizeSiteDomain(null)).toBe("");
    });
  });

  describe("isSiteResult", () => {
    it("matches the site's own host, with or without www", () => {
      expect(isSiteResult("https://example.com/x", "example.com")).toBe(true);
      expect(isSiteResult("https://www.example.com/x", "www.example.com")).toBe(true);
      expect(isSiteResult("https://example.com/x", "www.example.com")).toBe(true);
    });

    it("matches a subdomain of the site", () => {
      expect(isSiteResult("https://shop.example.com/x", "example.com")).toBe(true);
    });

    it("does not match a domain that merely contains the site as a substring", () => {
      expect(isSiteResult("https://notexample.com/x", "example.com")).toBe(false);
      expect(isSiteResult("https://example.com.evil.test/x", "example.com")).toBe(false);
    });

    it("does not match a Google wrapper carrying the site URL", () => {
      expect(isSiteResult("https://www.google.com/goto?url=https://example.com/x", "example.com")).toBe(false);
    });

    it("does not match when the site domain is empty", () => {
      expect(isSiteResult("https://example.com/x", "")).toBe(false);
    });
  });
});

/**
 * The breadcrumb is the only real identity in a live wrapper, and the provider
 * truncates it. Measured 2026-11-24: `"https://www.facebook.com › ... › L'Atelier
 * des Harmonies"`. Rebuilding a URL from that would invent
 * `https://facebook.com/.../L'Atelier des Harmonies`, a page that does not exist.
 */
describe("resolveRankedResult", () => {
  it("keeps a real URL as-is", () => {
    expect(resolveRankedResult({ url: "https://real.test/p", domain: "real.test" })).toEqual({
      url: "https://real.test/p",
      domain: "real.test",
    });
  });

  it("rebuilds a complete breadcrumb path", () => {
    expect(resolveRankedResult({
      url: "https://google.com/goto?url=CAES",
      domain: "google.com",
      breadcrumb: "https://www.harmonies-studio.fr › tarifs",
    })).toEqual({ url: "https://harmonies-studio.fr/tarifs", domain: "harmonies-studio.fr" });
  });

  it("keeps the domain but invents no URL when the path is truncated", () => {
    expect(resolveRankedResult({
      url: "https://google.com/goto?url=CAES",
      domain: "google.com",
      breadcrumb: "https://www.facebook.com › ... › L'Atelier des Harmonies",
    })).toEqual({ url: null, domain: "facebook.com" });
  });

  it("treats a unicode ellipsis as truncation too", () => {
    expect(resolveRankedResult({
      url: "https://google.com/goto?url=CAES",
      domain: "google.com",
      breadcrumb: "https://www.facebook.com › … › Some Page",
    })).toEqual({ url: null, domain: "facebook.com" });
  });

  it("returns nothing when no real host can be recovered", () => {
    expect(resolveRankedResult({ url: "https://google.com/goto?url=CAES", domain: "google.com", breadcrumb: null })).toBeNull();
    expect(resolveRankedResult({ url: "https://google.com/searchviewer/x", domain: "google.com", breadcrumb: "Plus de 390 abonnés" })).toBeNull();
  });

  it("falls back to an attributable declared domain", () => {
    expect(resolveRankedResult({ url: "", domain: "rival.test", breadcrumb: null })).toEqual({
      url: "https://rival.test/",
      domain: "rival.test",
    });
  });
});
