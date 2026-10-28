import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildSidebarGroups } from "@/components/layout/sidebar-nav";
import { selectedSiteDomain, siteDestination, siteSectionLabel } from "@/components/sites/site-switcher";
import { resolvePipelineStage } from "@/lib/pipeline/stages";
import { projectResultEvidence } from "@/lib/pipeline/results";
import { splitObservations } from "@/lib/research/aeo-geo-view";

const app = path.join(process.cwd(), "app");
function pages(dir = app): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === "page.tsx" ? [full] : [];
  });
}
function routeExists(href: string) {
  const segments = href.split("?")[0].split("/").filter(Boolean);
  return pages().some((page) => {
    const route = path.relative(app, path.dirname(page)).replaceAll(path.sep, "/").replace(/\([^/]+\)\/?/g, "").split("/").filter(Boolean);
    return route.length === segments.length && route.every((part, i) => part.startsWith("[") || part === segments[i]);
  });
}

describe("pipeline UI integration", () => {
  it("exposes overview, exactly five stages, and settings", () => {
    expect(buildSidebarGroups("site-1").map((group) => group.label)).toEqual([
      "Overview", "Business", "Research", "Findings", "Work", "Results", "Settings",
    ]);
  });

  it("has a matching page for every sidebar destination", () => {
    const groups = [...buildSidebarGroups(), ...buildSidebarGroups("site-1")];
    for (const group of groups) for (const item of group.items) expect(routeExists(item.href), item.href).toBe(true);
  });

  it("maps legacy destinations and preserves query filters and action identity", () => {
    expect(resolvePipelineStage("/sites/s1/intelligence")).toBeNull(); // remains an explicit report lens
    expect(resolvePipelineStage("/sites/s1/opportunities")).toBe("findings");
    expect(resolvePipelineStage("/sites/s1/content-studio")).toBe("work");
    expect(resolvePipelineStage("/sites/s1/aeo-geo")).toBe("findings");
    expect(resolvePipelineStage("/sites/s1/keyword-research")).toBe("research");
    expect(siteDestination("/sites/old/content-studio", "actionId=a7&tab=drafts&dimension=content", "new"))
      .toBe("/sites/new/work?actionId=a7&tab=drafts&dimension=content");
  });

  it("keeps switcher site context in the destination and the report label is domain-backed", () => {
    expect(siteDestination("/sites/old/findings", "tab=technical", "new")).toBe("/sites/new/findings?tab=technical");
    expect(siteDestination("/sites/old/opportunities", "dimension=seo", "new")).toBe("/sites/new/findings?dimension=seo");
    expect(siteSectionLabel("/sites/old/content-studio")).toBe("Work");
    expect(siteSectionLabel("/sites/old/aeo-geo")).toBe("AEO / GEO");
    expect(selectedSiteDomain([{ id: "new", domain: "pipeline-journey.test" }], "new")).toBe("pipeline-journey.test");
  });

  it("projects the synthetic journey as measured, without claiming attribution", () => {
    const result = projectResultEvidence({ actionId: "a", title: "Improve service page", status: "DELIVERED", updatedAt: new Date(), deliveryStatus: "VERIFIED", deliveredAt: new Date(), verifiedAt: new Date(), measuredAt: new Date(), outcomeRecorded: true });
    expect(result.result).toBe("measured_unattributed");
    const observations = splitObservations([
      { id: "customer", provider: "local-manual", modelSurface: "synthetic" },
      { id: "fixture", provider: "fixture", modelSurface: "fixture" },
    ]);
    expect(observations.customer.map(({ id }) => id)).toEqual(["customer"]);
    expect(observations.fixtures.map(({ id }) => id)).toEqual(["fixture"]);
  });
});
