import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DecisionSummaryPanel } from "@/components/funnel/decision-summary";

/**
 * The decision surface (brief §5). The detail page uses this component, so what is
 * asserted here is what a reader sees: readiness, measurement basis, track and
 * intervention, before the evidence.
 */
describe("decision summary panel", () => {
  it("shows a supported customer need with unquantified impact as actionable", () => {
    const html = renderToStaticMarkup(
      DecisionSummaryPanel({
        decision: {
          readiness: "actionable",
          measurement: "unquantified",
          track: "customer_value",
          intervention: "update_page",
          benefit: null,
          change: "Add a worked cost example and the current fee ranges.",
          targetPages: ["https://site.test/services"],
          successMeasure: "A buyer can state the expected cost after reading.",
          uncertainty: ["the frequency of the question is not measured"],
          coverage: "partially answers at https://site.test/services",
          needRationale: "Three buyers asked before booking.",
          needEvidenceUrls: ["https://forum.test/cost"],
          offerFitRationale: "The business makes fitted wardrobes.",
          offerFitEvidenceUrls: ["https://site.test/about"],
          assessmentModel: "fixture-model",
        },
      })
    );
    expect(html).toContain("Actionable");
    expect(html).toContain("Impact not quantified");
    expect(html).toContain("Customer value");
    expect(html).toContain("intervention · update page");
    expect(html).toContain("A person still decides whether to do it");
    expect(html).toContain("Add a worked cost example");
    expect(html).toContain("https://site.test/services");
    expect(html).toContain("A buyer can state the expected cost");
    expect(html).toContain("the frequency of the question is not measured");
    expect(html).toContain("Three buyers asked before booking.");
    expect(html).toContain("The business makes fitted wardrobes.");
    expect(html).toContain("fixture-model");
  });

  it("shows a rejected premise as rejected, not as a low-quality idea", () => {
    const html = renderToStaticMarkup(
      DecisionSummaryPanel({
        decision: {
          readiness: "rejected",
          measurement: "unquantified",
          track: null,
          intervention: "maintain",
          benefit: null,
        },
      })
    );
    expect(html).toContain("Rejected");
    expect(html).toContain("not offered as work");
  });

  it("separates an investigation from an actionable recommendation", () => {
    const html = renderToStaticMarkup(
      DecisionSummaryPanel({
        decision: {
          readiness: "needs_investigation",
          measurement: "observed_baseline",
          track: "organic_growth",
          intervention: "investigate",
          benefit: null,
        },
      })
    );
    expect(html).toContain("Needs investigation");
    expect(html).toContain("Observed baseline");
    expect(html).toContain("what the site already answers");
  });

  it("shows an adequate answer as no change, not as a missed opportunity", () => {
    const html = renderToStaticMarkup(
      DecisionSummaryPanel({
        decision: {
          readiness: "no_action",
          measurement: "unquantified",
          track: null,
          intervention: "maintain",
          benefit: null,
        },
      })
    );
    expect(html).toContain("No change");
    expect(html).toContain("no work is proposed");
  });

  it("renders nothing misleading when a legacy row has no decision", () => {
    const html = renderToStaticMarkup(
      DecisionSummaryPanel({ decision: { readiness: null, measurement: null, track: null, intervention: null, benefit: null } })
    );
    expect(html).toContain("Decision");
    expect(html).not.toContain("Actionable");
  });
});

describe("opportunity labels", () => {
  it("does not prescribe consolidation or a refresh as the plan", async () => {
    const { OPPORTUNITY_LABELS } = await import("@/lib/funnel/labels");
    expect(OPPORTUNITY_LABELS.O10_cannibalization.play).not.toMatch(/^Consolidate/);
    expect(OPPORTUNITY_LABELS.O10_cannibalization.play).toMatch(/Consolidate only if/);
    expect(OPPORTUNITY_LABELS.O11_freshness_decay.play).not.toMatch(/^Refresh the page/);
    expect(OPPORTUNITY_LABELS.O11_freshness_decay.play).toMatch(/before changing anything/);
  });

  it("does not require keyword validation to answer a customer need", async () => {
    const { OPPORTUNITY_LABELS } = await import("@/lib/funnel/labels");
    expect(OPPORTUNITY_LABELS.O13_user_pain_point.play).not.toMatch(/keyword/i);
    expect(OPPORTUNITY_LABELS.O13_user_pain_point.label).toBe("Customer need");
  });
});
