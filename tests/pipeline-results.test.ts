import { describe, expect, it } from "vitest";
import { projectResultEvidence } from "@/lib/pipeline/results";

const base = { actionId: "a1", title: "Update page", status: "DELIVERED", updatedAt: new Date("2026-01-01") };
describe("Results evidence projection", () => {
  it("distinguishes receipt from verification", () => {
    expect(projectResultEvidence({ ...base, deliveryStatus: "SUCCEEDED", deliveredAt: new Date(), verifiedAt: null, measuredAt: null, outcomeRecorded: false }).result).toBe("delivered_unverified");
  });
  it("does not treat a verification timestamp as a passing result or as measurement", () => {
    expect(projectResultEvidence({ ...base, deliveryStatus: "FAILED", deliveredAt: new Date(), verifiedAt: new Date(), measuredAt: null, outcomeRecorded: false }).result).toBe("verified_unmeasured");
  });
  it("labels an outcome measurement without causal attribution", () => {
    expect(projectResultEvidence({ ...base, deliveryStatus: "SUCCEEDED", deliveredAt: new Date(), verifiedAt: new Date(), measuredAt: new Date(), outcomeRecorded: true }).result).toBe("measured_unattributed");
  });
  it("prefers recorded measurement even when no delivery receipt is present", () => {
    expect(projectResultEvidence({ ...base, deliveryStatus: null, deliveredAt: null, verifiedAt: null, measuredAt: new Date(), outcomeRecorded: true }).result).toBe("measured_unattributed");
  });
  it("keeps missing evidence explicit", () => {
    expect(projectResultEvidence({ ...base, deliveryStatus: null, deliveredAt: null, verifiedAt: null, measuredAt: null, outcomeRecorded: false }).result).toBe("not_delivered");
  });
});
