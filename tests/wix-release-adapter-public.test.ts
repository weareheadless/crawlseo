/* eslint-disable @typescript-eslint/no-explicit-any -- fake Prisma and CLI clients keep the contract test focused. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state: any = {
    task: null,
    artifacts: [],
    sequence: 0,
    publishCalls: 0,
    failReceiptOnce: false,
    commits: 0,
    gitCalls: 0,
  };
  const db: any = {};
  db.agentTask = {
    findUnique: vi.fn(async () => ({ ...state.task, action: { ...state.task.action } })),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (state.task.id !== where.id || state.task.status !== where.status
          || state.task.actionRevision !== where.actionRevision || state.task.commitSha !== where.commitSha
          || (where.action?.is?.revision && state.task.action.revision !== where.action.is.revision)) return { count: 0 };
      Object.assign(state.task, data);
      return { count: 1 };
    }),
  };
  db.agentTaskArtifact = {
    findMany: vi.fn(async ({ where, orderBy, take }: any) => state.artifacts
      .filter((item: any) => item.taskId === where.taskId && where.kind.in.includes(item.kind))
      .sort((a: any, b: any) => orderBy?.createdAt === "desc" ? b.sequence - a.sequence : a.sequence - b.sequence)
      .slice(0, take ?? state.artifacts.length)
      .map((item: any) => ({ kind: item.kind, content: item.content, createdAt: new Date(item.sequence) }))),
  };
  db.researchAction = { findUnique: vi.fn(async () => ({ revision: state.task.action.revision })) };
  const addAgentArtifact = vi.fn(async (taskId: string, value: any) => {
    if (value.kind === "wix_publish_receipt" && state.failReceiptOnce) {
      state.failReceiptOnce = false;
      throw new Error("artifact storage unavailable after publish");
    }
    const item = { taskId, ...value, sequence: ++state.sequence };
    state.artifacts.push(item);
    return item;
  });
  const updateAgentTask = vi.fn(async (_taskId: string, value: any) => {
    Object.assign(state.task, value);
    return { ...state.task };
  });
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: async (_file: string, args: string[]) => {
      state.gitCalls += 1;
      const command = args.slice(2);
      if (command[0] === "status") return { stdout: "", stderr: "" };
      if (command[0] === "branch") return { stdout: "main\n", stderr: "" };
      if (command[0] === "rev-parse" && command[1] === "origin/main") return { stdout: "site-head\n", stderr: "" };
      if (command[0] === "rev-parse" && command[1] === "HEAD") {
        return { stdout: args[1] === state.task.worktreePath ? `${state.task.commitSha}\n` : "site-head\n", stderr: "" };
      }
      if (command[0] === "show") return { stdout: "\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });
  return { state, db, addAgentArtifact, updateAgentTask, execFile };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: h.execFile };
});
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/agent-tasks/commit", () => ({ commitAgentTask: vi.fn(async () => { h.state.commits += 1; return { commitSha: h.state.commitSha }; }) }));
vi.mock("@/lib/agent-tasks/deploy", () => ({ markActionVerified: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-tasks/service", () => ({ updateAgentTask: h.updateAgentTask }));
vi.mock("@/lib/agent-tasks/chat", () => ({ addAgentArtifact: h.addAgentArtifact }));
vi.mock("@/lib/site-delivery/config", () => ({ getSiteDeliveryConfig: vi.fn(async () => ({ enabled: true, adapters: [] })) }));
vi.mock("@/lib/agent-tasks/targets", () => ({ isTechnicalSeoAction: vi.fn(() => true) }));
vi.mock("@/lib/delivery/target-selection", () => ({ selectEmbedTargetKey: vi.fn() }));
vi.mock("@/lib/delivery/wix-publish", () => ({
  readWixConfig: vi.fn(async () => ({ siteId: "legacy-site" })),
  publishWixSite: vi.fn(async () => {
    h.state.publishCalls += 1;
    return {
      codeSha: "site-head", releaseSha: "release-head",
      revisionBefore: { revision: "8", number: 8 }, revisionPublished: { revision: "8", number: 8 },
      revisionAfter: { revision: "8", number: 8 }, previewUrl: null, output: "published",
    };
  }),
  WixPublicationOutcomeUnknown: class WixPublicationOutcomeUnknown extends Error {},
}));
vi.mock("@/lib/research/release-verification", () => ({ verifyReleaseOutcome: vi.fn(async () => ({ supported: false, verified: null })) }));
vi.mock("@/lib/delivery/wix-embed", () => ({
  applyEmbedDelivery: vi.fn(), planEmbedDelivery: vi.fn(), verifyEmbedDelivery: vi.fn(),
}));

import { approveAndReleaseAgentTask } from "@/lib/agent-tasks/release";
import { publishWixSite } from "@/lib/delivery/wix-publish";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-release-1", siteId: "site-1", status: "AWAITING_REVIEW", title: "Technical SEO",
    actionId: "action-1", actionRevision: 5, connectorGeneration: null,
    repoPath: "/tmp/fake-site", branch: "agent/task", worktreePath: "/tmp/fake-worktree",
    commitSha: "reviewed-task-commit", route: "/", action: {
      revision: 5, title: "Technical SEO", recommendation: "Fix metadata", targetUrl: "/",
      source: "technical", kind: "technical", evidence: null, site: { domain: "example.invalid" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  h.state.task = task();
  h.state.commitSha = "reviewed-task-commit";
  h.state.artifacts = [];
  h.state.sequence = 0;
  h.state.publishCalls = 0;
  h.state.failReceiptOnce = false;
  h.state.commits = 0;
  h.state.gitCalls = 0;
  h.db.agentTask.findUnique.mockClear();
  h.db.agentTask.updateMany.mockClear();
  h.db.agentTaskArtifact.findMany.mockClear();
  h.db.researchAction.findUnique.mockClear();
  h.addAgentArtifact.mockClear();
  h.updateAgentTask.mockClear();
  (publishWixSite as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe("public Wix release concurrency and receipt boundaries", () => {
  it("allows one release claimant for a shared Action revision", async () => {
    const results = await Promise.allSettled([
      approveAndReleaseAgentTask("task-release-1"),
      approveAndReleaseAgentTask("task-release-1"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(publishWixSite).toHaveBeenCalledTimes(1);
    expect(h.state.task.status).toBe("CLOSED");
  });

  it("does not mislabel a lost local receipt as not-started or publish again", async () => {
    h.state.failReceiptOnce = true;
    await expect(approveAndReleaseAgentTask("task-release-1")).rejects.toThrow(/release failed/);
    expect(h.state.publishCalls).toBe(1);
    expect(h.state.artifacts.map((item: any) => item.kind)).toContain("wix_publish_unknown");

    // A later non-started record cannot conceal the older unknown outcome.
    await h.addAgentArtifact("task-release-1", {
      kind: "wix_publish_not_started",
      content: JSON.stringify({ attemptId: "later", outcome: "not_started" }),
    });
    await expect(approveAndReleaseAgentTask("task-release-1")).rejects.toThrow(/release failed/);
    expect(h.state.publishCalls).toBe(1);
  });

  it("rejects stale Action revisions and connector-bound private publisher use before Git effects", async () => {
    h.state.task.action.revision = 6;
    await expect(approveAndReleaseAgentTask("task-release-1")).rejects.toThrow(/Action revision changed/);
    expect(h.state.gitCalls).toBe(0);
    expect(publishWixSite).not.toHaveBeenCalled();

    h.state.task = task({ connectorGeneration: 4 });
    await expect(approveAndReleaseAgentTask("task-release-1")).rejects.toThrow(/unsupported for connector-bound Actions/);
    expect(h.state.gitCalls).toBe(0);
  });
});
