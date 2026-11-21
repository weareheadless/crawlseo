import { afterEach, describe, expect, it, vi } from "vitest";

const writeBusinessKnowledge = vi.fn(async (input: { changes: Record<string, unknown>; idempotencyKey: string }) => ({
  revision: 2,
  state: "working",
  documentId: "business-p1",
  changes: input.changes,
}));

vi.mock("@/lib/projects/business-knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects/business-knowledge")>();
  return { ...actual, writeBusinessKnowledge: (input: unknown) => writeBusinessKnowledge(input as never) };
});

import { proposeKnowledgeFromResearch } from "@/lib/research/knowledge-proposal";

/**
 * Research may propose business facts, but it never outranks a person and never
 * writes a fact the owner cannot trace to a source.
 */

const finding = {
  id: "f1",
  type: "CONCERN",
  theme: "Entretien",
  summary: "Les clients demandent comment entretenir une lampe en grès.",
  demandQueries: ["entretien lampe gres"],
  evidenceSourceIds: ["src-1"],
};

function db(options: {
  fields?: Record<string, unknown>;
  sources?: Array<{ id: string; url: string }>;
} = {}) {
  return {
    researchFinding: { findMany: vi.fn(async () => [finding]) },
    researchSource: { findMany: vi.fn(async () => options.sources ?? [{ id: "src-1", url: "https://forum.example/thread" }]) },
    businessKnowledgeDocument: {
      findUnique: vi.fn(async () => options.fields === undefined ? null : {
        logicalId: "business-p1",
        revision: 1,
        revisions: [{ fields: options.fields }],
      }),
    },
    project: { findUniqueOrThrow: vi.fn(async () => ({ workspaceId: "w1" })) },
    businessKnowledgeRevision: {},
  };
}

function completion(updates: unknown[]) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ updates }) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  writeBusinessKnowledge.mockClear();
});

function configured() {
  vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
  vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
  vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
}

describe("research knowledge proposal", () => {
  it("writes an advised, source-attributed fact and leaves a confirmed one alone", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion([
      { field: "concerns", value: ["entretien du grès"], finding_indexes: [0] },
      { field: "services", value: ["Lampes artisanales"], finding_indexes: [0] },
    ])));

    const result = await proposeKnowledgeFromResearch(
      db({
        fields: {
          services: { value: ["Lampes artisanales"], provenance: { kind: "owner_input", status: "owner_confirmed" }, publicationUse: "approved" },
        },
      }) as never,
      { projectId: "p1", siteId: "s1", runId: "run-1" }
    );

    expect(result.proposed).toEqual(["concerns"]);
    expect(result.skippedConfirmed).toEqual(["services"]);
    expect(result.revision).toBe(2);

    const written = writeBusinessKnowledge.mock.calls[0][0] as { changes: Record<string, { value: unknown; provenance: { kind: string; status: string; evidenceUri: string }; publicationUse: string }> };
    expect(written.changes.concerns.provenance).toMatchObject({
      kind: "research_observation",
      status: "advised",
      evidenceUri: "https://forum.example/thread",
    });
    expect(written.changes.concerns.publicationUse).toBe("internal_only");
    expect(written.changes.services).toBeUndefined();
  });

  it("writes nothing when the proposal repeats the stored value", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion([
      { field: "concerns", value: ["entretien du grès"], finding_indexes: [0] },
    ])));

    const result = await proposeKnowledgeFromResearch(
      db({
        fields: {
          concerns: { value: ["entretien du grès"], provenance: { kind: "ai_observation", status: "assumed" }, publicationUse: "internal_only" },
        },
      }) as never,
      { projectId: "p1", siteId: "s1", runId: "run-1" }
    );

    expect(result.unchanged).toEqual(["concerns"]);
    expect(result.revision).toBeNull();
    expect(writeBusinessKnowledge).not.toHaveBeenCalled();
  });

  it("refuses a proposal it cannot attribute to a source", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion([
      { field: "concerns", value: ["entretien du grès"], finding_indexes: [0] },
    ])));

    const result = await proposeKnowledgeFromResearch(db({ sources: [] }) as never, {
      projectId: "p1", siteId: "s1", runId: "run-1",
    });

    expect(result.rejected).toEqual([{ field: "concerns", reason: "no source URL could be attributed" }]);
    expect(writeBusinessKnowledge).not.toHaveBeenCalled();
  });
});
