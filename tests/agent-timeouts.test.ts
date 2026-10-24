import { describe, expect, it } from "vitest";
import { agentTimeouts } from "@/lib/agent-tasks/timeouts";

describe("agent timeouts", () => {
  it("allows long-running batch work while still detecting inactivity", () => {
    expect(agentTimeouts({ batch: true, env: {} })).toEqual({
      inactivityMs: 20 * 60_000,
      maxRuntimeMs: 120 * 60_000,
    });
  });

  it("uses shorter limits for normal tasks and supports overrides", () => {
    expect(agentTimeouts({ batch: false, env: {} })).toEqual({
      inactivityMs: 15 * 60_000,
      maxRuntimeMs: 60 * 60_000,
    });
    expect(agentTimeouts({
      batch: false,
      env: {
        AGENT_INACTIVITY_TIMEOUT_MINUTES: "30",
        AGENT_MAX_RUNTIME_MINUTES: "180",
      },
    })).toEqual({
      inactivityMs: 30 * 60_000,
      maxRuntimeMs: 180 * 60_000,
    });
  });
});
