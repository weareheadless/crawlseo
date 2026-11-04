import { describe, expect, it } from "vitest";

import { assessCustomerNeed } from "@/lib/funnel/assess-need";
import { assessCoverage } from "@/lib/research/page-coverage";
import { buildPageInventory } from "@/lib/research/page-inventory";
import { verifySiteClaim } from "@/lib/research/site-claims";
import { TENANT_FIXTURES } from "./fixtures/customer-recommendations";

/**
 * End-to-end acceptance for the customer-centred brief (§1, §7).
 *
 * Each fixture is run through the same path the product uses: page inventory →
 * coverage assessment → claim verification → decision. Nothing here asserts on a
 * model's prose; the conclusion must follow from the stored page content.
 */
describe("cross-tenant recommendation quality", () => {
  for (const tenant of TENANT_FIXTURES) {
    describe(tenant.name, () => {
      const inventory = buildPageInventory(tenant.pages.map((page) => ({ url: page.url, contentScore: 0 })));
      const pages = tenant.pages.map((page) => ({
        url: page.url,
        title: page.title,
        contentText: page.contentText || null,
        unavailableReason: page.statusCode && page.statusCode !== 200 ? `HTTP ${page.statusCode}` : null,
      }));

      for (const finding of tenant.findings) {
        it(`decides "${finding.theme}"`, () => {
          const statement = finding.claim?.statement ?? finding.summary;
          const coverage = assessCoverage({ statement }, pages);
          const verification = finding.claim
            ? verifySiteClaim({ ...finding.claim, pageType: finding.claim.pageType ?? null }, {
                inventory: inventory.groups,
                coverage,
                coverageComplete: tenant.crawlComplete,
              })
            : null;

          const decision = assessCustomerNeed({
            label: finding.theme,
            statement,
            clusterSize: 1,
            verification: verification?.status ?? null,
            verificationReason: verification?.reason ?? null,
            coverageState: coverage[0]?.state ?? null,
            coveragePage: coverage[0]?.pageUrl ?? null,
            coverageComplete: tenant.crawlComplete,
            businessFit: finding.businessFit === "contradicted"
              ? { value: 0.5, source: "unknown" }
              : { value: 0.9, source: "knowledge" },
            businessFitState: finding.businessFit ?? "supported",
            businessFitRationale: finding.businessFit === "contradicted"
              ? "the site serves Riviera Maya inventory, not this market"
              : undefined,
            kind: finding.type === "POSITIONING_GAP" ? "offer" : "need",
          });

          const expected = tenant.expectations[finding.theme];
          expect(expected, `no expectation for ${finding.theme}`).toBeTruthy();
          expect(decision.readiness).toBe(expected.readiness);
          expect(decision.reasons.join(" ")).toContain(expected.reasonContains);
        });
      }
    });
  }
});

describe("negative controls", () => {
  it("does not claim a page is missing when a page answers the need", () => {
    const pages = [{
      url: "https://unseen.example/services",
      title: "Our joinery services",
      contentText: "Fitted wardrobes, staircases, kitchens and bespoke furniture. We work with homeowners and interior designers.",
    }];
    const coverage = assessCoverage({ statement: "fitted wardrobes and bespoke furniture for homeowners" }, pages);
    expect(coverage[0]?.state).toBe("answers");
  });

  it("treats a rate-limited page as unassessable, not as an absent answer", () => {
    const pages = [{
      url: "https://www.atelier-harmonie.com/category/abat-jours",
      title: "Checking Your Request",
      contentText: null,
      unavailableReason: "HTTP 429",
    }];
    const coverage = assessCoverage({ statement: "abat-jours sur mesure" }, pages);
    expect(coverage[0]?.state).toBe("unassessable");
  });

  it("keeps a supported need with unknown demand actionable", () => {
    const decision = assessCustomerNeed({
      statement: "Customers ask whether a fitted wardrobe can be moved to a new house",
      clusterSize: 1,
      verification: null,
      verificationReason: null,
      coverageState: "partially_answers",
      coveragePage: "https://unseen.example/services",
      coverageComplete: true,
      businessFit: { value: 0.9, source: "knowledge" },
      kind: "need",
    });
    expect(decision.readiness).toBe("actionable");
    expect(decision.measurement).toBe("unquantified");
  });
});
