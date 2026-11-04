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
        },
      })
    );
    expect(html).toContain("Actionable");
    expect(html).toContain("Impact not quantified");
    expect(html).toContain("Customer value");
    expect(html).toContain("intervention · update page");
    expect(html).toContain("A person still decides whether to do it");
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

  it("renders nothing misleading when a legacy row has no decision", () => {
    const html = renderToStaticMarkup(
      DecisionSummaryPanel({ decision: { readiness: null, measurement: null, track: null, intervention: null, benefit: null } })
    );
    expect(html).toContain("Decision");
    expect(html).not.toContain("Actionable");
  });
});
