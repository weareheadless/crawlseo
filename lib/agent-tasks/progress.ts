/** One line the agent run reported, as the review page shows it. */
export type AgentProgressLine = { at: string; message: string };

export type AgentProgressState = {
  stage: string;
  startedAt: string;
  updatedAt: string;
  lines: AgentProgressLine[];
  /** Lines older than the retained window, so the UI can say what it dropped. */
  dropped: number;
};

/**
 * One readable line for an opencode JSON event.
 *
 * The runner stores the agent's raw event stream as an artifact; this is the
 * human view of it. A bare `Tool: bash` told the operator nothing about what
 * the agent was doing, so a tool call carries its argument: the command for a
 * shell call, the path for a read or edit, the pattern for a search.
 */
export function progressLineForEvent(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      part?: {
        type?: unknown;
        text?: unknown;
        tool?: unknown;
        name?: unknown;
        state?: { status?: unknown; input?: unknown };
      };
    };
    if (event.type === "step_start") return "Thinking…";
    // A finished step is implied by the next line; it only adds noise.
    if (event.type === "step_finish") return null;
    if (event.type === "text" && typeof event.part?.text === "string") {
      const text = event.part.text.replace(/\s+/g, " ").trim();
      return text ? `Agent: ${text.slice(0, 220)}` : null;
    }
    const tool = typeof event.part?.tool === "string"
      ? event.part.tool
      : typeof event.part?.name === "string"
        ? event.part.name
        : null;
    if (tool && (event.type === "tool_use" || event.part?.type === "tool")) {
      const input = event.part?.state?.input;
      const detail = input && typeof input === "object" && !Array.isArray(input)
        ? toolDetail(input as Record<string, unknown>)
        : "";
      const failed = event.part?.state?.status === "error";
      const prefix = failed ? "✗" : "•";
      return detail ? `${prefix} ${tool}: ${detail}` : `${prefix} ${tool}`;
    }
  } catch {
    // Ignore non-JSON output.
  }
  return null;
}

/** The argument that makes a tool call recognisable, shortened to one line. */
function toolDetail(input: Record<string, unknown>): string {
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  };
  const command = first("command", "cmd");
  if (command) return oneLine(command, 200);
  const file = first("filePath", "file_path", "path", "file");
  if (file) return oneLine(file, 200);
  const pattern = first("pattern", "query", "url", "description");
  if (pattern) return oneLine(pattern, 200);
  return "";
}

function oneLine(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read the progress a run has written so far.
 *
 * `result.progress` is the only live channel between the worker and the page,
 * so its shape is read defensively: an older task may have no `dropped` count
 * and a partially written line is skipped rather than rendered as `undefined`.
 */
export function readAgentProgress(result: unknown): AgentProgressState {
  const progress = record(record(result).progress);
  const lines = Array.isArray(progress.lines)
    ? progress.lines
        .map((line) => record(line))
        .filter((line) => typeof line.message === "string")
        .map((line) => ({
          at: typeof line.at === "string" ? line.at : "",
          message: String(line.message),
        }))
    : [];
  return {
    stage: typeof progress.stage === "string" ? progress.stage : "Not started",
    startedAt: typeof progress.startedAt === "string" ? progress.startedAt : "",
    updatedAt: typeof progress.updatedAt === "string" ? progress.updatedAt : "",
    lines,
    dropped: typeof progress.dropped === "number" && progress.dropped > 0 ? progress.dropped : 0,
  };
}
