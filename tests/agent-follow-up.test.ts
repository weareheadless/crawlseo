import { describe, expect, it } from "vitest";

import { acceptsAgentFollowUp, followUpTargetStatus } from "@/lib/agent-tasks/transitions";

describe("agent follow-ups", () => {
  it("accepts a note wherever a new run can start", () => {
    for (const status of ["READY", "CHANGES_REQUESTED", "AWAITING_REVIEW", "AWAITING_TARGET", "PUBLISHED", "FAILED"]) {
      expect(acceptsAgentFollowUp(status), status).toBe(true);
    }
  });

  it("refuses a note while a run or delivery is in flight, or when the task is dead", () => {
    for (const status of ["RUNNING", "PUBLISHING", "CANCELLED", "COMPLETED"]) {
      expect(acceptsAgentFollowUp(status), status).toBe(false);
    }
  });

  it("reopens a reviewed task for change requests, and a failed one at READY", () => {
    expect(followUpTargetStatus("AWAITING_REVIEW")).toBe("CHANGES_REQUESTED");
    expect(followUpTargetStatus("PUBLISHED")).toBe("CHANGES_REQUESTED");
    expect(followUpTargetStatus("FAILED")).toBe("READY");
    // Already runnable states stay where they are.
    expect(followUpTargetStatus("READY")).toBe("READY");
    expect(followUpTargetStatus("CHANGES_REQUESTED")).toBe("CHANGES_REQUESTED");
  });
});
