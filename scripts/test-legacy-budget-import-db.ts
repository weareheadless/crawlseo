import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

async function main() {
const baseUrlValue = process.env.DATABASE_URL;
if (!baseUrlValue) throw new Error("DATABASE_URL is required for the isolated migration test");

const schema = `cseo_migration_test_${randomUUID().replaceAll("-", "")}`;
const baseUrl = new URL(baseUrlValue);
const isolatedUrl = new URL(baseUrl);
isolatedUrl.searchParams.set("schema", schema);
const admin = new PrismaClient({ datasources: { db: { url: baseUrl.toString() } } });
let appDb: typeof import("@/lib/db").db | null = null;

try {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Migrations failed in isolated schema (exit ${(error as { status?: number }).status ?? "unknown"})`);
  }

  process.env.DATABASE_URL = isolatedUrl.toString();
  const { db } = await import("@/lib/db");
  const { freezeLegacyBudgetSourceDispatch, importLegacyBudget } = await import("@/lib/billing/legacy-budget-import");
  appDb = db;
  async function quietExpectedFailure<T>(operation: () => Promise<T>): Promise<T> {
    const previous = console.error;
    console.error = () => undefined;
    try { return await operation(); }
    finally { console.error = previous; }
  }

  const suffix = randomUUID();
  const [sourceWorkspace, targetWorkspace] = await Promise.all([
    db.workspace.create({ data: { externalOrganizationId: `test-source-${suffix}`, name: "Migration test source" } }),
    db.workspace.create({ data: { externalOrganizationId: `test-target-${suffix}`, name: "Migration test target" } }),
  ]);
  const [sourceProject, targetProject] = await Promise.all([
    db.project.create({ data: { workspaceId: sourceWorkspace.id, externalProjectId: `test-ext-${suffix}`, name: "Source" } }),
    db.project.create({ data: { workspaceId: targetWorkspace.id, externalProjectId: `test-ext-${suffix}`, name: "Target" } }),
  ]);
  const [sourceSite, targetSite] = await Promise.all([
    db.site.create({ data: { projectId: sourceProject.id, domain: "example.test" } }),
    db.site.create({ data: { projectId: targetProject.id, domain: "example.test" } }),
  ]);
  await db.seoResearchPolicy.create({ data: {
    projectId: sourceProject.id, siteId: sourceSite.id, enabled: true, articleResearchEnabled: true,
  } });
  await db.researchPolicy.create({ data: { siteId: sourceSite.id, enabled: true, revision: 8 } });
  await db.connectorBinding.create({ data: {
    projectId: targetProject.id, siteId: targetSite.id, executor: "helloada", generation: 4,
  } });

  const createdAt = new Date("2026-10-15T12:00:00.000Z");
  const settledAt = new Date("2026-10-15T12:05:00.000Z");
  async function sourceTask(index: number) {
    return db.articleKeywordResearchRun.create({ data: {
      projectId: sourceProject.id,
      siteId: sourceSite.id,
      ideaKey: `test-idea-${index}`,
      ideaSummary: "Synthetic isolated integration test",
      idempotencyKey: `source-task-${suffix}-${index}`,
      requestHash: "a".repeat(64),
      seed: "test keyword",
      kind: "KEYWORD_OVERVIEW",
      language: "en",
      country: "US",
      status: "COMPLETED",
      providerTaskId: `provider-${suffix}-${index}`,
      costMicros: 12345,
      requestedAt: createdAt,
      attemptedAt: createdAt,
      completedAt: settledAt,
      createdAt,
      updatedAt: settledAt,
    } });
  }

  const freezeInput = {
    sourceProjectId: sourceProject.id,
    sourceSiteId: sourceSite.id,
    targetSiteId: targetSite.id,
    expectedBindingGeneration: 4,
    idempotencyKey: `freeze-${suffix}`,
    reason: "Isolated migration integration test",
  };
  const freezePlan = await freezeLegacyBudgetSourceDispatch({ ...freezeInput, mode: "freeze-source-plan" });
  const frozen = await freezeLegacyBudgetSourceDispatch({ ...freezeInput, mode: "freeze-source-apply",
    expectedSourcePolicyHash: freezePlan.sourceDispatchHash });
  const freezeReplay = await freezeLegacyBudgetSourceDispatch({ ...freezeInput, mode: "freeze-source-apply",
    expectedSourcePolicyHash: freezePlan.sourceDispatchHash });
  if (!frozen.frozen || !freezeReplay.reused) throw new Error("Freeze apply/replay failed");
  await db.researchPolicy.update({ where: { siteId: sourceSite.id }, data: { revision: { increment: 1 } } });
  let changedFreezeStateRejected = false;
  try {
    await quietExpectedFailure(() => freezeLegacyBudgetSourceDispatch({ ...freezeInput, mode: "freeze-source-apply",
      expectedSourcePolicyHash: freezePlan.sourceDispatchHash }));
  } catch { changedFreezeStateRejected = true; }
  if (!changedFreezeStateRejected) throw new Error("Freeze replay accepted a changed source policy revision");

  async function makeImport(index: number) {
    const task = await sourceTask(index);
    const row = {
      localReservationId: `local-${suffix}-${index}`,
      taskId: task.id,
      operation: "dataforseo:article_keyword_overview" as const,
      legacyStatus: "settled" as const,
      period: "2026-10",
      timeZone: "UTC",
      currency: "USD",
      amountMicros: "100000",
      createdAt: createdAt.toISOString(),
      updatedAt: settledAt.toISOString(),
      settledAt: settledAt.toISOString(),
    };
    const input = {
      sourceProjectId: sourceProject.id,
      sourceSiteId: sourceSite.id,
      targetSiteId: targetSite.id,
      expectedBindingGeneration: 4,
      idempotencyKey: `import-${suffix}-${index}`,
      rows: [row],
    };
    const plan = await importLegacyBudget({ ...input, mode: "plan" });
    return { input, plan };
  }

  const first = await makeImport(1);
  const [firstApply, firstReplay] = await quietExpectedFailure(() => Promise.all([
    importLegacyBudget({ ...first.input, mode: "apply", expectedSourceEvidenceHash: first.plan.sourceEvidenceHash }),
    importLegacyBudget({ ...first.input, mode: "apply", expectedSourceEvidenceHash: first.plan.sourceEvidenceHash }),
  ]));
  if (!firstApply.receiptId || firstApply.receiptId !== firstReplay.receiptId) {
    throw new Error("Concurrent exact replay did not converge to one receipt");
  }
  if (Number(firstApply.reused) + Number(firstReplay.reused) !== 1) {
    throw new Error("Concurrent exact replay did not return one fresh result and one reused result");
  }
  const firstReceipt = await db.legacyBudgetImportReceipt.findUnique({ where: { id: firstApply.receiptId } });
  const receiptSnapshot = firstReceipt?.snapshot as { rows?: unknown[] } | undefined;
  if (!receiptSnapshot || !Array.isArray(receiptSnapshot.rows) || receiptSnapshot.rows.length !== 1) {
    throw new Error("Import receipt snapshot shape changed");
  }

  const second = await makeImport(2);
  const [secondOne, secondTwo] = await quietExpectedFailure(() => Promise.all([
    importLegacyBudget({ ...second.input, mode: "apply", expectedSourceEvidenceHash: second.plan.sourceEvidenceHash }),
    importLegacyBudget({ ...second.input, mode: "apply", expectedSourceEvidenceHash: second.plan.sourceEvidenceHash }),
  ]));
  if (!secondOne.receiptId || secondOne.receiptId !== secondTwo.receiptId) {
    throw new Error("Concurrent first apply did not converge to one receipt");
  }
  if (Number(secondOne.reused) + Number(secondTwo.reused) !== 1) {
    throw new Error("Concurrent first apply did not return one fresh result and one reused result");
  }

  const reservations = await db.researchBudgetReservation.count({ where: { projectId: targetProject.id } });
  if (reservations !== 2) throw new Error(`Expected 2 reservations, found ${reservations}`);

  const immutableQueries = [
    () => db.$executeRaw`UPDATE "LegacyBudgetImportReceipt" SET "requestHash" = 'tampered' WHERE "id" = ${firstApply.receiptId}`,
    () => db.$executeRaw`DELETE FROM "LegacyBudgetImportReceipt" WHERE "id" = ${firstApply.receiptId}`,
    () => db.$executeRaw`UPDATE "LegacyBudgetSourceFreezeReceipt" SET "reason" = 'tampered' WHERE "id" = ${frozen.receiptId}`,
    () => db.$executeRaw`DELETE FROM "LegacyBudgetSourceFreezeReceipt" WHERE "id" = ${frozen.receiptId}`,
  ];
  for (const query of immutableQueries) {
    let rejected = false;
    try { await quietExpectedFailure(query); } catch { rejected = true; }
    if (!rejected) throw new Error("Receipt trigger accepted an UPDATE or DELETE");
  }

  let foreignKeyRestricted = false;
  try { await quietExpectedFailure(() => db.project.delete({ where: { id: sourceProject.id } })); }
  catch { foreignKeyRestricted = true; }
  if (!foreignKeyRestricted) throw new Error("Receipt foreign key allowed project deletion");
  console.log(JSON.stringify({ isolatedMigrations: true, freezeReplay: true, concurrentReplay: true,
    reservationCount: reservations, importSnapshotRows: receiptSnapshot.rows.length,
    immutableTriggers: true, foreignKeyRestricted: true }));
} finally {
  if (appDb) await appDb.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
}
}

main().catch((error) => {
  console.error("ISOLATED_DB_TEST_FAILED", error instanceof Error ? error.name : "unknown error");
  process.exitCode = 1;
});
