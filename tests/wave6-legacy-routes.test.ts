import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_ROUTE_DESTINATION,
  archivedDestination,
  legacyRoutesArchived,
} from "@/lib/funnel/legacy-routes";

const original = process.env.CRAWLSEO_LEGACY_ROUTES;

afterEach(() => {
  if (original === undefined) delete process.env.CRAWLSEO_LEGACY_ROUTES;
  else process.env.CRAWLSEO_LEGACY_ROUTES = original;
});

describe("wave 6 legacy route archive", () => {
  it("archives by default: the safe state after cutover", () => {
    delete process.env.CRAWLSEO_LEGACY_ROUTES;
    expect(legacyRoutesArchived()).toBe(true);
  });

  it("redirects every archived route to the funnel surface that replaced it", () => {
    delete process.env.CRAWLSEO_LEGACY_ROUTES;
    expect(archivedDestination("legacy-work", "s1")).toBe("/sites/s1/work");
    expect(archivedDestination("legacy-opportunities", "s1")).toBe("/sites/s1/opportunities");
    expect(archivedDestination("findings", "s1")).toBe("/sites/s1/opportunities");
    expect(archivedDestination("results", "s1")).toBe("/sites/s1/work");
    expect(archivedDestination("actions", "s1")).toBe("/sites/s1/work");
  });

  it("can be reopened without a code change", () => {
    process.env.CRAWLSEO_LEGACY_ROUTES = "live";
    expect(legacyRoutesArchived()).toBe(false);
    expect(archivedDestination("findings", "s1")).toBeNull();
  });

  it("only treats the exact value live as reopening", () => {
    process.env.CRAWLSEO_LEGACY_ROUTES = "LIVE";
    expect(legacyRoutesArchived()).toBe(true);
    process.env.CRAWLSEO_LEGACY_ROUTES = "";
    expect(legacyRoutesArchived()).toBe(true);
  });

  it("declares a destination for every route", () => {
    for (const route of ["legacy-work", "legacy-opportunities", "actions", "findings", "results"] as const) {
      expect(LEGACY_ROUTE_DESTINATION[route]).toMatch(/^(work|opportunities)$/);
    }
  });
});
