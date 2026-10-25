import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  freezeLegacyBudgetSourceDispatch,
  importLegacyBudget,
  LegacyBudgetImportError,
  type LegacyBudgetImportInput,
  type LegacyBudgetImportRow,
} from "@/lib/billing/legacy-budget-import";

const sourceProjectId = "source-project";
const sourceSiteId = "source-site";
const targetProjectId = "target-project";
const targetSiteId = "target-site";

function row(index: number, values: Partial<LegacyBudgetImportRow> = {}): LegacyBudgetImportRow {
  const when = new Date(`2026-10-${String(6 + index).padStart(2, "0")}T14:05:15.000Z`);
  return {
    localReservationId: `growth-budget-${index}`,
    taskId: `run-${index}`,
    operation: index === 2 ? "dataforseo:article_serp_snapshot" : "dataforseo:article_keyword_overview",
    legacyStatus: index === 3 ? "reserved" : "settled",
    period: "2026-10",
    timeZone: "UTC",
    currency: "USD",
    amountMicros: "100000",
    createdAt: when.toISOString(),
    updatedAt: new Date(when.getTime() + 5000).toISOString(),
    settledAt: index === 3 ? null : new Date(when.getTime() + 2000).toISOString(),
    ...values,
  };
}

function input(values: Partial<LegacyBudgetImportInput> = {}): LegacyBudgetImportInput {
  return {
    mode: "plan",
    sourceProjectId,
    sourceSiteId,
    targetSiteId,
    expectedBindingGeneration: 4,
    idempotencyKey: "oceanic-history-v1",
    rows: [row(1), row(2), row(3)],
    ...values,
  };
}

function makeHarness() {
  const imported: Array<Record<string, any>> = [];
  let receipt: { id: string; idempotencyKey: string; requestHash: string; sourceEvidenceHash: string; reservationIds: string[]; snapshot: unknown } | null = null;
  let txQueue = Promise.resolve();
  const source = {
    id: sourceSiteId, projectId: sourceProjectId, domain: "oceanicvibes.com",
    project: { id: sourceProjectId, externalProjectId: "oceanicvibes", status: "ACTIVE", workspaceId: "source-workspace",
      researchBudgetCurrency: "USD", workspace: { id: "source-workspace", status: "ACTIVE" } },
  };
  const target = {
    id: targetSiteId, projectId: targetProjectId, domain: "oceanicvibes.com",
    project: { id: targetProjectId, externalProjectId: "oceanicvibes", status: "ACTIVE", workspaceId: "target-workspace",
      researchBudgetCurrency: "USD", researchBudgetRevision: 9,
      workspace: { id: "target-workspace", status: "ACTIVE" } },
  };
  type TestTask = { id: string; projectId: string; siteId: string; status: string; kind: string; providerTaskId: string | null;
    costMicros: number | null; requestedAt: Date; attemptedAt: Date | null; completedAt: Date | null; updatedAt: Date };
  let tasks: TestTask[] = [
    { id: "run-1", projectId: sourceProjectId, siteId: sourceSiteId, status: "COMPLETED", kind: "KEYWORD_OVERVIEW",
      providerTaskId: "provider-task-1", costMicros: 12_120, requestedAt: new Date("2026-10-06T14:05:17.000Z"),
      attemptedAt: new Date("2026-10-06T14:05:18.000Z"), completedAt: new Date("2026-10-06T14:05:19.000Z"), updatedAt: new Date("2026-10-06T14:05:19.000Z") },
    { id: "run-2", projectId: sourceProjectId, siteId: sourceSiteId, status: "FAILED", kind: "ORGANIC_SERP",
      providerTaskId: null, costMicros: null, requestedAt: new Date("2026-10-07T14:05:17.000Z"),
      attemptedAt: new Date("2026-10-07T14:05:18.000Z"), completedAt: new Date("2026-10-07T14:05:19.000Z"), updatedAt: new Date("2026-10-07T14:05:19.000Z") },
    { id: "run-3", projectId: sourceProjectId, siteId: sourceSiteId, status: "UNCERTAIN", kind: "KEYWORD_OVERVIEW",
      providerTaskId: null, costMicros: null, requestedAt: new Date("2026-10-08T14:05:17.000Z"),
      attemptedAt: null, completedAt: null, updatedAt: new Date("2026-10-08T14:05:17.000Z") },
  ];
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...args: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "LegacyBudgetImportReceipt"')) {
        return receipt?.idempotencyKey === String(args[1]) ? [receipt] : [];
      }
      if (sql.includes('FROM "ResearchBudgetReservation"') && sql.includes('legacy-budget-import')) {
        return imported.map((item) => ({ id: item.id }));
      }
      if (sql.includes('FROM "ResearchBudgetReservation"')) {
        const sourceTaskIds = args.map(String);
        return imported.filter((item) => sourceTaskIds.includes(item.detail?.sourceTaskId)
          || sourceTaskIds.includes(item.providerTaskId)).map((item) => ({ id: item.id }));
      }
      return [];
    }),
    $executeRaw: vi.fn(async (parts: TemplateStringsArray, ...args: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('INSERT INTO "LegacyBudgetImportReceipt"')) {
        receipt = { id: String(args[0]), idempotencyKey: String(args[5]), requestHash: String(args[6]), sourceEvidenceHash: String(args[7]),
          reservationIds: JSON.parse(String(args[8])) as string[], snapshot: JSON.parse(String(args[9])) };
      }
      return 1;
    }),
    site: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      if (where.id === sourceSiteId) return source;
      if (where.id === targetSiteId) return target;
      return null;
    }) },
    connectorBinding: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ projectId: targetProjectId, siteId: targetSiteId,
        executor: "helloada", generation: 4, status: "ACTIVE" })),
    },
    articleKeywordResearchRun: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => tasks.filter((task) => where.id.in.includes(task.id))),
      count: vi.fn(async () => tasks.filter((task) => task.status === "REQUESTED" || task.status === "ATTEMPTING").length),
    },
    seoResearchRun: { count: vi.fn(async () => 0) },
    researchRun: { count: vi.fn(async () => 0) },
    seoResearchPolicy: { findUnique: vi.fn(async () => ({ enabled: false, articleResearchEnabled: false })) },
    researchPolicy: { findUnique: vi.fn(async () => ({ enabled: false })) },
    researchBudgetReservation: {
      findUnique: vi.fn(async ({ where }: { where: { projectId_idempotencyKey: { idempotencyKey: string } } }) =>
        imported.find((item) => item.idempotencyKey === where.projectId_idempotencyKey.idempotencyKey) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const created = { ...data, id: `imported-${imported.length + 1}` };
        imported.push(created);
        return { id: created.id };
      }),
    },
  };
  mockDb.$transaction.mockImplementation((callback: (client: typeof tx) => Promise<unknown>) => {
    const current = txQueue.then(() => callback(tx));
    txQueue = current.then(() => undefined, () => undefined);
    return current;
  });
  return {
    tx, imported,
    setTasks: (next: TestTask[]) => { tasks = next; },
    setTargetDomain: (domain: string) => { target.domain = domain; },
    setTargetExternalProjectId: (externalProjectId: string) => { target.project.externalProjectId = externalProjectId; },
    getReceipt: () => receipt,
  };
}

describe("guarded historical budget import", () => {
  beforeEach(() => vi.clearAllMocks());

  it("plans from scoped provider tasks without writing and reports terminal statuses and actuals", async () => {
    const h = makeHarness();
    const result = await importLegacyBudget(input());
    expect(result).toMatchObject({ mode: "plan", reused: false, source: { siteId: sourceSiteId }, target: { siteId: targetSiteId, bindingGeneration: 4 } });
    expect("rows" in result ? result.rows : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "run-1", status: "SETTLED", actualCostMicros: "12120" }),
      expect.objectContaining({ taskId: "run-2", status: "UNCERTAIN", actualCostMicros: null, amountMicros: "100000" }),
      expect.objectContaining({ taskId: "run-3", status: "UNCERTAIN", actualCostMicros: null }),
    ]));
    expect(result.sourceEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.imported).toHaveLength(0);
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    const lockQueries = h.tx.$queryRaw.mock.calls.map(([parts]) => parts.join("?"));
    expect(lockQueries.some((sql) => sql.includes('FROM "Project"') && sql.includes('ORDER BY "id" FOR UPDATE'))).toBe(true);
    expect(lockQueries.some((sql) => sql.includes('FROM "Site"') && sql.includes('ORDER BY "id" FOR UPDATE'))).toBe(true);
    expect(lockQueries.some((sql) => sql.includes('FROM "ConnectorBinding"') && sql.includes('ORDER BY "id" FOR UPDATE'))).toBe(true);
  });

  it("applies only the reviewed hash and preserves quote, month, timezone, currency and source timestamps", async () => {
    const h = makeHarness();
    const plan = await importLegacyBudget(input());
    const result = await importLegacyBudget(input({ mode: "apply", expectedSourceEvidenceHash: plan.sourceEvidenceHash }));
    expect(result).toMatchObject({ mode: "apply", reused: false, reservationIds: ["imported-1", "imported-2", "imported-3"] });
    expect(h.imported).toHaveLength(3);
    const settled = h.imported.find((item) => item.providerTaskId === "provider-task-1");
    expect(settled).toBeDefined();
    if (!settled) throw new Error("Settled row was not imported");
    expect(settled).toMatchObject({ period: "2026-10", timeZone: "UTC", currency: "USD", amountMicros: BigInt(100000),
      actualCostMicros: BigInt(12120), status: "SETTLED", policyRevision: 9, siteId: targetSiteId });
    expect(settled.createdAt.toISOString()).toBe(row(1).createdAt);
    expect(settled.updatedAt.toISOString()).toBe(row(1).updatedAt);
    const uncertain = h.imported.find((item) => item.detail.sourceTaskId === "run-2");
    expect(uncertain).toMatchObject({ status: "UNCERTAIN", amountMicros: BigInt(100000), actualCostMicros: null, settledAt: null });
    const run3 = h.imported.find((item) => item.detail.sourceTaskId === "run-3");
    expect(run3).toMatchObject({ status: "UNCERTAIN", amountMicros: BigInt(100000), actualCostMicros: null, settledAt: null });
    expect(h.getReceipt()?.sourceEvidenceHash).toBe(plan.sourceEvidenceHash);
  });

  it("serializes concurrent retries and returns one immutable receipt", async () => {
    const h = makeHarness();
    const plan = await importLegacyBudget(input());
    const apply = input({ mode: "apply", expectedSourceEvidenceHash: plan.sourceEvidenceHash });
    const [first, second] = await Promise.all([importLegacyBudget(apply), importLegacyBudget(apply)]);
    expect(first.receiptId).toBe(second.receiptId);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(h.imported).toHaveLength(3);
  });

  it("rejects a changed payload under the same idempotency key", async () => {
    const h = makeHarness();
    const plan = await importLegacyBudget(input());
    const changed = input({ rows: [row(1, { amountMicros: "100001" }), row(2), row(3)] });
    await importLegacyBudget(input({ mode: "apply", expectedSourceEvidenceHash: plan.sourceEvidenceHash }));
    await expect(importLegacyBudget({ ...changed, mode: "apply", expectedSourceEvidenceHash: plan.sourceEvidenceHash }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(h.imported).toHaveLength(3);
  });

  it("does not duplicate source reservations under a different import key", async () => {
    const h = makeHarness();
    const plan = await importLegacyBudget(input());
    await importLegacyBudget(input({ mode: "apply", expectedSourceEvidenceHash: plan.sourceEvidenceHash }));
    await expect(importLegacyBudget(input({ idempotencyKey: "oceanic-history-v2" })))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already (imported|have a budget ledger)/i) });
    expect(h.imported).toHaveLength(3);
  });

  it("rejects reusing a source task with a different local reservation id", async () => {
    const h = makeHarness();
    const plan = await importLegacyBudget(input({ rows: [row(1)] }));
    await importLegacyBudget(input({ rows: [row(1)], mode: "apply", expectedSourceEvidenceHash: plan.sourceEvidenceHash }));
    await expect(importLegacyBudget(input({ idempotencyKey: "different-key", rows: [row(1, { localReservationId: "different-local-id" })] })))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(h.imported).toHaveLength(1);
  });

  it("rejects changed source records, mismatched scope, active old executor, bad generation, currency and operation", async () => {
    const stale = makeHarness();
    const stalePlan = await importLegacyBudget(input());
    stale.setTasks([
      { id: "run-1", projectId: sourceProjectId, siteId: sourceSiteId, status: "COMPLETED", kind: "KEYWORD_OVERVIEW",
        providerTaskId: "provider-task-1", costMicros: 12000, requestedAt: new Date("2026-10-06T14:05:17Z"),
        attemptedAt: new Date("2026-10-06T14:05:18Z"), completedAt: new Date("2026-10-06T14:05:19Z"), updatedAt: new Date("2026-10-06T14:05:19Z") },
      { id: "run-2", projectId: sourceProjectId, siteId: sourceSiteId, status: "FAILED", kind: "ORGANIC_SERP",
        providerTaskId: null, costMicros: null, requestedAt: new Date("2026-10-07T14:05:17Z"),
        attemptedAt: new Date("2026-10-07T14:05:18Z"), completedAt: new Date("2026-10-07T14:05:19Z"), updatedAt: new Date("2026-10-07T14:05:19Z") },
      { id: "run-3", projectId: sourceProjectId, siteId: sourceSiteId, status: "REQUESTED", kind: "KEYWORD_OVERVIEW",
        providerTaskId: null, costMicros: null, requestedAt: new Date("2026-10-08T14:05:17Z"), attemptedAt: null, completedAt: null,
        updatedAt: new Date("2026-10-08T14:05:17Z") },
    ]);
    await expect(importLegacyBudget(input({ mode: "apply", expectedSourceEvidenceHash: stalePlan.sourceEvidenceHash })))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(stale.imported).toHaveLength(0);

    const scope = makeHarness();
    scope.setTasks([{ ...({} as any), id: "run-1", projectId: "wrong-project", siteId: "wrong-site", status: "COMPLETED",
      kind: "KEYWORD_OVERVIEW", providerTaskId: "provider-task-1", costMicros: 12000,
      requestedAt: new Date("2026-10-06T14:05:17Z"), attemptedAt: null, completedAt: null, updatedAt: new Date() }]);
    await expect(importLegacyBudget(input({ rows: [row(1)] }))).rejects.toMatchObject({ statusCode: 409 });

    const active = makeHarness();
    active.tx.connectorBinding.findMany.mockResolvedValueOnce([{ id: "old-binding", siteId: sourceSiteId, executor: "other", generation: 1 }] as never);
    await expect(importLegacyBudget(input())).rejects.toMatchObject({ statusCode: 409 });

    const generation = makeHarness();
    generation.tx.connectorBinding.findUnique.mockResolvedValueOnce({ projectId: targetProjectId, executor: "helloada", generation: 5, status: "ACTIVE" } as never);
    await expect(importLegacyBudget(input())).rejects.toMatchObject({ statusCode: 409 });

    const currency = makeHarness();
    await expect(importLegacyBudget(input({ rows: [row(1, { currency: "EUR" })] }))).rejects.toMatchObject({ statusCode: 409 });
    const operation = makeHarness();
    await expect(importLegacyBudget(input({ rows: [row(1, { operation: "dataforseo:article_serp_snapshot" })] })))
      .rejects.toMatchObject({ statusCode: 409 });
    const domain = makeHarness();
    domain.setTargetDomain("another-domain.example");
    await expect(importLegacyBudget(input())).rejects.toMatchObject({ statusCode: 409 });
    const externalIdentity = makeHarness();
    externalIdentity.setTargetExternalProjectId("different-external-project");
    await expect(importLegacyBudget(input())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a caller hash that does not match current server-derived evidence", async () => {
    makeHarness();
    await expect(importLegacyBudget(input({ expectedSourceEvidenceHash: "0".repeat(64) })))
      .rejects.toBeInstanceOf(LegacyBudgetImportError);
  });

  it("requires nonempty identities and refuses to import any nonterminal task with a partial cost", async () => {
    const empty = makeHarness();
    empty.setTargetExternalProjectId("");
    await expect(importLegacyBudget(input())).rejects.toMatchObject({ statusCode: 409 });

    const running = makeHarness();
    running.setTasks([{ id: "run-1", projectId: sourceProjectId, siteId: sourceSiteId, status: "ATTEMPTING", kind: "KEYWORD_OVERVIEW",
      providerTaskId: "provider-task-1", costMicros: 12000, requestedAt: new Date("2026-10-06T14:05:17Z"),
      attemptedAt: new Date("2026-10-06T14:05:18Z"), completedAt: null, updatedAt: new Date("2026-10-06T14:05:19Z") }]);
    running.tx.articleKeywordResearchRun.count.mockResolvedValueOnce(0);
    await expect(importLegacyBudget(input({ rows: [row(1)] }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects queued source work before any import can race its paid dispatch", async () => {
    const h = makeHarness();
    h.setTasks([{ id: "run-1", projectId: sourceProjectId, siteId: sourceSiteId, status: "REQUESTED", kind: "KEYWORD_OVERVIEW",
      providerTaskId: null, costMicros: null, requestedAt: new Date("2026-10-06T14:05:17Z"), attemptedAt: null,
      completedAt: null, updatedAt: new Date("2026-10-06T14:05:17Z") }]);
    await expect(importLegacyBudget(input({ rows: [row(1)] }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects signed bigint overflow and persists the full audit snapshot in the receipt", async () => {
    const h = makeHarness();
    await expect(importLegacyBudget(input({ rows: [row(1, { amountMicros: "9223372036854775808" })] })))
      .rejects.toMatchObject({ statusCode: 400 });
    const plan = await importLegacyBudget(input());
    await importLegacyBudget(input({ mode: "apply", expectedSourceEvidenceHash: plan.sourceEvidenceHash }));
    expect(h.getReceipt()?.snapshot).toMatchObject({
      source: { projectId: sourceProjectId, externalProjectId: "oceanicvibes" },
      target: { projectId: targetProjectId, bindingGeneration: 4 },
      rows: expect.arrayContaining([expect.objectContaining({
        input: expect.objectContaining({ localReservationId: "growth-budget-1" }),
        sourceTask: expect.objectContaining({ id: "run-1", costMicros: 12120 }),
        effective: expect.objectContaining({ status: "SETTLED", actualCostMicros: "12120" }),
      })]),
    });
  });
});

describe("source dispatch freeze compare-and-set", () => {
  beforeEach(() => vi.clearAllMocks());

  it("locks pinned identities, pauses policy with a revision bump, and reuses only the matching receipt", async () => {
    const frozenAt = new Date("2026-10-25T12:00:00.000Z");
    let seo = { id: "seo-policy", enabled: true, articleResearchEnabled: true, updatedAt: new Date("2026-08-29T01:01:08.119Z") };
    let research = { id: "research-policy", enabled: true, revision: 6, updatedAt: new Date("2026-08-29T01:01:08.119Z") };
    let receipt: Record<string, any> | null = null;
    const locks: string[] = [];
    const source = { id: sourceSiteId, projectId: sourceProjectId, domain: "oceanicvibes.com",
      project: { id: sourceProjectId, externalProjectId: "oceanicvibes", status: "ACTIVE" } };
    const target = { id: targetSiteId, projectId: targetProjectId, domain: "oceanicvibes.com",
      project: { id: targetProjectId, externalProjectId: "oceanicvibes", status: "ACTIVE",
        workspace: { status: "ACTIVE" } } };
    const tx = {
      $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...args: unknown[]) => {
        const sql = parts.join("?");
        locks.push(sql);
        if (sql.includes('FROM "LegacyBudgetSourceFreezeReceipt"')) return receipt ? [receipt] : [];
        return [];
      }),
      $executeRaw: vi.fn(async (_parts: TemplateStringsArray, ...args: unknown[]) => {
        receipt = { id: String(args[0]), requestHash: String(args[7]), sourcePolicyHash: String(args[8]),
          snapshot: JSON.parse(String(args[9])) };
        return 1;
      }),
      site: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === sourceSiteId ? source : where.id === targetSiteId ? target : null) },
      connectorBinding: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => ({ projectId: targetProjectId, executor: "helloada", status: "ACTIVE", generation: 4 })),
      },
      seoResearchPolicy: {
        findUnique: vi.fn(async () => seo),
        update: vi.fn(async () => { seo = { ...seo, enabled: false, articleResearchEnabled: false, updatedAt: frozenAt }; return seo; }),
      },
      researchPolicy: {
        findUnique: vi.fn(async () => research),
        update: vi.fn(async () => { research = { ...research, enabled: false, revision: research.revision + 1, updatedAt: frozenAt }; return research; }),
        create: vi.fn(),
      },
      articleKeywordResearchRun: { count: vi.fn(async () => 0) },
      seoResearchRun: { count: vi.fn(async () => 0) },
      researchRun: { count: vi.fn(async () => 0) },
    };
    mockDb.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    const base = { sourceProjectId, sourceSiteId, targetSiteId, expectedBindingGeneration: 4,
      idempotencyKey: "pause-source-v1", reason: "verified project migration; prevent duplicate paid research" };
    const plan = await freezeLegacyBudgetSourceDispatch({ ...base, mode: "freeze-source-plan" });
    expect(plan.sourceDispatchHash).toMatch(/^[a-f0-9]{64}$/);
    const lockedRelations = locks.filter((sql) => sql.includes("FOR UPDATE"));
    expect(lockedRelations[0]).toContain('FROM "Project"');
    expect(lockedRelations[1]).toContain('FROM "Site"');
    expect(lockedRelations[2]).toContain('FROM "SeoResearchPolicy"');
    expect(lockedRelations[3]).toContain('FROM "ResearchPolicy"');
    const applied = await freezeLegacyBudgetSourceDispatch({ ...base, mode: "freeze-source-apply", expectedSourcePolicyHash: plan.sourceDispatchHash });
    expect(applied).toMatchObject({ frozen: true, snapshot: { before: { research: { revision: 6 } },
      after: { seo: { enabled: false, articleResearchEnabled: false }, research: { enabled: false, revision: 7 } } } });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const replay = await freezeLegacyBudgetSourceDispatch({ ...base, mode: "freeze-source-apply", expectedSourcePolicyHash: plan.sourceDispatchHash });
    expect(replay).toMatchObject({ reused: true, receiptId: applied.receiptId });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
