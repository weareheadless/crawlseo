import { describe, expect, it } from "vitest";

import { assessCustomerNeed } from "@/lib/funnel/assess-need";
import type { NeedAssessment } from "@/lib/research/need-assessment";
import { assessCoverage } from "@/lib/research/page-coverage";
import { buildPageInventory } from "@/lib/research/page-inventory";
import { verifySiteClaim } from "@/lib/research/site-claims";
import { TENANT_FIXTURES, type FixtureAssessment } from "./fixtures/customer-recommendations";

/**
 * Deterministic regression suite for the customer-centred brief (§1, §7).
 *
 * What this proves: the decision wiring. Each fixture supplies page text, a claim
 * and — where work is expected — a pre-made structured assessment, so the test
 * checks that verification, coverage and readiness compose as specified.
 *
 * What this does NOT prove: that the model reasons well about a real business.
 * That evidence comes from `scripts/evaluate-need-assessment.ts`, which runs the
 * real extractor and assessor against live sites. Keeping the two apart stops a
 * hand-written fixture from being reported as live recommendation quality.
 */

function assessmentFromFixture(
  fixture: FixtureAssessment,
  finding: { theme: string; summary: string }
): NeedAssessment {
  return {
    premise: { state: "unverified", rationale: "the fixture supplies no premise verdict", evidenceUrls: [] },
    need: {
      state: fixture.needState,
      rationale: `Fixture assessment for: ${finding.summary}`,
      evidenceUrls: [],
    },
    offerFit: {
      state: fixture.offerFitState,
      rationale: `Fixture assessment for: ${finding.theme}`,
      evidenceUrls: [],
    },
    coverage: fixture.coverage.map((row) => ({
      pageUrl: row.pageUrl,
      state: row.state,
      method: "semantic",
      matchedTerms: [],
      excerpts: row.excerpts ?? [],
      note: row.note,
    })),
    intervention: fixture.intervention,
    change: fixture.change,
    targetPages: fixture.targetPages ?? [],
    expectedBenefit: fixture.expectedBenefit ?? "",
    uncertainty: [],
    review: fixture.review ?? "none",
    successMeasure: fixture.successMeasure ?? "",
    model: "fixture",
    promptVersion: "fixture/1",
    assessedAt: "2026-11-04T00:00:00.000Z",
  };
}

describe("cross-tenant recommendation quality (deterministic)", () => {
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
            assessment: finding.assessment ? assessmentFromFixture(finding.assessment, finding) : null,
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

  it("keeps an assessed need with unknown demand actionable", () => {
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
      assessment: {
        premise: { state: "unverified", rationale: "the page list does not settle the premise", evidenceUrls: [] },
        need: { state: "supported", rationale: "Two customers asked before booking", evidenceUrls: ["https://forum.test/moving"] },
        offerFit: { state: "supported", rationale: "The site installs fitted wardrobes", evidenceUrls: ["https://unseen.example/services"] },
        coverage: [{
          pageUrl: "https://unseen.example/services",
          state: "partially_answers",
          method: "semantic",
          matchedTerms: [],
          excerpts: ["Fitted wardrobes, staircases, kitchens and bespoke furniture."],
          note: "It lists the service but not whether a wardrobe can be moved.",
        }],
        intervention: "update_page",
        change: "Add a paragraph on dismantling and re-fitting a wardrobe during a move.",
        targetPages: ["https://unseen.example/services"],
        expectedBenefit: "A moving customer can judge whether to keep or replace the wardrobe.",
        uncertainty: ["the frequency of the question is not measured"],
        review: "none",
        successMeasure: "A moving customer can answer the question from the page.",
        model: "fixture",
        promptVersion: "fixture/1",
        assessedAt: "2026-11-04T00:00:00.000Z",
      },
    });
    expect(decision.readiness).toBe("actionable");
    expect(decision.measurement).toBe("unquantified");
  });

  it("does not turn a knowledge document into business fit on its own", () => {
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
    expect(decision.readiness).toBe("research_backlog");
    expect(decision.businessFit.state).toBe("unverified");
  });
});
