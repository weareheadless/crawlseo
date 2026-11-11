import { describe, expect, it } from "vitest";

import { progressLineForEvent, readAgentProgress } from "@/lib/agent-tasks/progress";

function event(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

/**
 * The console is the only place the operator sees a run, so a line has to say
 * what happened. `Tool: bash` was technically true and practically useless.
 */
describe("run progress lines", () => {
  it("names the command a shell tool ran", () => {
    const line = progressLineForEvent(event({
      type: "tool_use",
      part: { tool: "bash", state: { status: "completed", input: { command: "git status --short\nhead -20" } } },
    }));
    expect(line).toBe("• bash: git status --short head -20");
  });

  it("names the file a read or edit touched", () => {
    expect(progressLineForEvent(event({
      type: "tool_use",
      part: { tool: "read", state: { input: { filePath: "src/public/custom-elements/nav.js" } } },
    }))).toBe("• read: src/public/custom-elements/nav.js");
    expect(progressLineForEvent(event({
      type: "tool_use",
      part: { tool: "edit", state: { input: { path: "src/app.js" } } },
    }))).toBe("• edit: src/app.js");
  });

  it("names the pattern a search used", () => {
    expect(progressLineForEvent(event({
      type: "tool_use",
      part: { tool: "grep", state: { input: { pattern: "customElements.define" } } },
    }))).toBe("• grep: customElements.define");
  });

  it("marks a failed tool call", () => {
    const line = progressLineForEvent(event({
      type: "tool_use",
      part: { tool: "bash", state: { status: "error", input: { command: "npm test" } } },
    }));
    expect(line).toBe("✗ bash: npm test");
  });

  it("keeps what the agent said, and drops step noise", () => {
    expect(progressLineForEvent(event({
      type: "text",
      part: { text: "I will check the packet first.\nThen the mount." },
    }))).toBe("Agent: I will check the packet first. Then the mount.");
    expect(progressLineForEvent(event({ type: "step_start", part: {} }))).toBe("Thinking…");
    expect(progressLineForEvent(event({ type: "step_finish", part: {} }))).toBeNull();
  });

  it("ignores output that is not an event", () => {
    expect(progressLineForEvent("Downloading model…")).toBeNull();
    expect(progressLineForEvent("")).toBeNull();
  });
});

describe("reading stored progress", () => {
  it("returns the lines a run reported", () => {
    const progress = readAgentProgress({
      progress: {
        stage: "Review ready",
        startedAt: "2026-11-11T14:45:47.000Z",
        updatedAt: "2026-11-11T14:46:00.000Z",
        lines: [
          { at: "2026-11-11T14:45:48.000Z", message: "Thinking…" },
          { at: "2026-11-11T14:45:49.000Z", message: "• bash: ls" },
        ],
      },
    });
    expect(progress.stage).toBe("Review ready");
    expect(progress.lines).toHaveLength(2);
    expect(progress.dropped).toBe(0);
  });

  it("reports lines the retained window dropped, and survives an old task", () => {
    expect(readAgentProgress({ progress: { lines: [], dropped: 12 } }).dropped).toBe(12);
    const empty = readAgentProgress(null);
    expect(empty.lines).toEqual([]);
    expect(empty.stage).toBe("Not started");
    expect(empty.dropped).toBe(0);
  });
});
