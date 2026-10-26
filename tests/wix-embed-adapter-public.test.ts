/* eslint-disable @typescript-eslint/no-explicit-any -- fake Prisma and bridge clients keep the contract test focused. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => {
  const state: any = {
    task: null,
    target: null,
    binding: null,
    capabilityResponse: { version: "0.1.0" },
    artifacts: [],
    deliveries: [],
    sequence: 0,
    currentHtml: "",
    failWrite: false,
    failReadCount: 0,
    written: new Map(),
  };
  const db: any = {};
  db.agentTask = {
    findUnique: vi.fn(async () => state.task && structuredClone(state.task)),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!state.task || state.task.id !== where.id || state.task.status !== where.status
          || state.task.actionRevision !== where.actionRevision) return { count: 0 };
      Object.assign(state.task, data);
      return { count: 1 };
    }),
  };
  db.deliveryTarget = { findUnique: vi.fn(async () => state.target && structuredClone(state.target)) };
  db.connectorBinding = { findUnique: vi.fn(async () => state.binding && structuredClone(state.binding)) };
  db.agentTaskArtifact = {
    findMany: vi.fn(async ({ where, orderBy, take }: any) => state.artifacts
      .filter((item: any) => item.taskId === where.taskId && (Array.isArray(where.kind?.in) ? where.kind.in.includes(item.kind) : item.kind === where.kind))
      .sort((a: any, b: any) => orderBy?.createdAt === "desc" ? b.sequence - a.sequence : a.sequence - b.sequence)
      .slice(0, take ?? state.artifacts.length)
      .map((item: any) => ({ ...item }))),
    create: vi.fn(async ({ data }: any) => {
      const item = { ...data, sequence: ++state.sequence };
      state.artifacts.push(item);
      return item;
    }),
  };
  db.delivery = { create: vi.fn(async ({ data }: any) => { state.deliveries.push(data); return data; }) };
  db.$transaction = vi.fn(async (operation: any) => operation(db));
  const bridge = {
    assertNegotiatedWixBridgeOperations: vi.fn(async (_alias: string, operations: string[]) => {
      const response = state.capabilityResponse;
      if (response?.contract !== "wix-bridge-generic-v1"
          || operations.some((operation) => operation === "update_snippet" || response.capabilities?.[operation] !== true)) {
        throw new Error(`Wix bridge capability is unsupported or unnegotiated: ${operations.join(",")}`);
      }
    }),
    readBridgeSnippet: vi.fn(async () => {
      if (state.failReadCount > 0) { state.failReadCount -= 1; throw new Error("read unavailable"); }
      return { snippet: { embedData: { html: state.currentHtml } } };
    }),
    updateBridgeSnippet: vi.fn(async (_alias: string, _snippet: string, file: string, apply: boolean) => {
      if (!apply) return { status: "planned" };
      const html = state.written.get(file) ?? await (await import("node:fs/promises")).readFile(file, "utf8");
      if (state.failWrite) { state.failReadCount = 2; throw new Error("connection reset"); }
      state.currentHtml = html;
      return { status: "accepted" };
    }),
  };
  const addArtifact = vi.fn(async (taskId: string, data: any) => {
    const item = { taskId, ...data, sequence: ++state.sequence };
    state.artifacts.push(item);
    return item;
  });
  return { state, db, bridge, addArtifact };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/bridge/client", () => ({
  assertNegotiatedWixBridgeOperations: h.bridge.assertNegotiatedWixBridgeOperations,
  readBridgeSnippet: h.bridge.readBridgeSnippet,
  updateBridgeSnippet: h.bridge.updateBridgeSnippet,
}));
vi.mock("@/lib/site-delivery/config", () => ({ getSiteDeliveryConfig: vi.fn(async () => ({ enabled: true, bridgeAlias: "test-site" })) }));
vi.mock("@/lib/agent-tasks/chat", () => ({ addAgentArtifact: h.addArtifact }));

import { applyEmbedDelivery, planEmbedDelivery, verifyEmbedDelivery } from "@/lib/delivery/wix-embed";

const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function snippet(html: string) {
  return `<script>(window.__atelierPacketsV51||(window.__atelierPacketsV51=[])).push({"key":"navbar","index":0,"count":1,"encoded":"${html}"});</script>`;
}

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wix-embed-public-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "wix-test@example.invalid");
  git(root, "config", "user.name", "Wix Test");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/navbar.js"), "export const nav = 'reviewed';\n");
  git(root, "add", "src/navbar.js");
  git(root, "commit", "-m", "reviewed navbar");

  h.state.sequence = 0;
  h.state.artifacts = [];
  h.state.deliveries = [];
  h.state.currentHtml = snippet("YQ==");
  h.state.failWrite = false;
  h.state.failReadCount = 0;
  h.state.written = new Map();
  h.state.binding = null;
  h.state.capabilityResponse = { version: "0.1.0" };
  h.state.target = {
    key: "navbar",
    siteId: "site-1",
    enabled: true,
    snippetId: "snippet-1",
    sourcePath: "src/navbar.js",
    componentTag: "navbar",
    route: "/",
    metadata: { packetFormat: "atelier-v51", packetKey: "navbar", pageScope: ["/"] },
  };
  h.state.task = {
    id: "task-1", siteId: "site-1", status: "COMMITTED", worktreePath: root,
    actionId: "action-1", actionRevision: 2, connectorGeneration: null, title: "Navbar",
    commitSha: git(root, "rev-parse", "HEAD"), action: { revision: 2 },
  };
  h.bridge.readBridgeSnippet.mockClear();
  h.bridge.updateBridgeSnippet.mockClear();
  h.db.agentTask.updateMany.mockClear();
  h.db.delivery.create.mockClear();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public Wix embed planning, apply, and reconcile operations", () => {
  it("rejects stale approval inputs and a binding that disappeared before any write", async () => {
    const plan = await planEmbedDelivery("task-1", "navbar");
    h.state.task.action.revision = 3;
    await expect(applyEmbedDelivery("task-1", "navbar", plan.confirmation)).rejects.toThrow(/Action revision changed/);
    expect(h.bridge.updateBridgeSnippet).toHaveBeenCalledTimes(1); // the plan call only

    h.state.task.action.revision = 2;
    h.state.task.connectorGeneration = 4;
    await expect(planEmbedDelivery("task-1", "navbar")).rejects.toThrow(/binding changed/);
    expect(h.bridge.readBridgeSnippet).toHaveBeenCalledTimes(1);
  });

  it("rejects changed live content and the old unbound magic confirmation", async () => {
    const plan = await planEmbedDelivery("task-1", "navbar");
    h.state.currentHtml = `${h.state.currentHtml}<!-- concurrent edit -->`;
    await expect(applyEmbedDelivery("task-1", "navbar", plan.confirmation)).rejects.toThrow(/changed after review/);
    h.state.currentHtml = snippet("YQ==");
    await expect(applyEmbedDelivery("task-1", "navbar", "apply-embed:task-1:navbar")).rejects.toThrow(/exact embed effect/);
    expect(h.state.task.status).toBe("COMMITTED");
    expect(h.bridge.updateBridgeSnippet).toHaveBeenCalledTimes(1);
  });

  it("atomically allows only one concurrent apply for a reviewed task", async () => {
    const plan = await planEmbedDelivery("task-1", "navbar");
    const results = await Promise.allSettled([
      applyEmbedDelivery("task-1", "navbar", plan.confirmation),
      applyEmbedDelivery("task-1", "navbar", plan.confirmation),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(h.bridge.updateBridgeSnippet).toHaveBeenCalledTimes(2); // one plan, one apply
    expect(h.state.deliveries).toHaveLength(1);
    expect(h.state.task.status).toBe("PUBLISHED");
  });

  it("blocks connector-bound work before bridge reads when the generic response is unnegotiated", async () => {
    h.state.task.connectorGeneration = 3;
    h.state.binding = { id: "binding-1", executor: "crawlseo-agent", generation: 3, status: "ACTIVE" };
    await expect(planEmbedDelivery("task-1", "navbar")).rejects.toThrow(/unsupported or unnegotiated/);
    expect(h.bridge.assertNegotiatedWixBridgeOperations).toHaveBeenCalledWith("test-site", ["read_embed", "update_snippet"]);
    expect(h.bridge.readBridgeSnippet).not.toHaveBeenCalled();
    expect(h.bridge.updateBridgeSnippet).not.toHaveBeenCalled();
  });

  it("reconciles only the immutable attempted hash and finalizes a lost response once", async () => {
    const firstPlan = await planEmbedDelivery("task-1", "navbar");
    const firstDesired = await readFile(firstPlan.htmlFile, "utf8");
    h.state.failWrite = true;
    await expect(applyEmbedDelivery("task-1", "navbar", firstPlan.confirmation)).rejects.toThrow(/reconcile before retrying/);
    expect(h.state.task.status).toBe("PUBLISHING");

    // A later plan is not approval evidence for the already attempted effect.
    h.state.failWrite = false;
    h.state.currentHtml = `${h.state.currentHtml}<!-- later state -->`;
    await planEmbedDelivery("task-1", "navbar");
    h.state.currentHtml = firstDesired;

    const [left, right] = await Promise.all([
      verifyEmbedDelivery("task-1", "navbar"),
      verifyEmbedDelivery("task-1", "navbar"),
    ]);
    expect(left.verified && right.verified).toBe(true);
    expect(h.state.task.status).toBe("PUBLISHED");
    expect(h.state.deliveries).toHaveLength(1);
    expect(h.state.artifacts.filter((item: any) => item.kind === "embed_reconcile")).toHaveLength(1);
  });

  it("does not reconcile an attempt if its matching immutable plan is missing", async () => {
    const plan = await planEmbedDelivery("task-1", "navbar");
    h.state.failWrite = true;
    await expect(applyEmbedDelivery("task-1", "navbar", plan.confirmation)).rejects.toThrow(/reconcile before retrying/);
    h.state.artifacts = h.state.artifacts.filter((item: any) => item.kind !== "embed_plan");
    h.state.failWrite = false;
    h.state.currentHtml = await readFile(plan.htmlFile, "utf8");

    const result = await verifyEmbedDelivery("task-1", "navbar");
    expect(result.verified).toBe(false);
    expect(h.state.task.status).toBe("PUBLISHING");
    expect(h.state.deliveries).toHaveLength(0);
  });
});
