import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) throw new Error("DATABASE_URL must be supplied by the isolated test runner");
const schema = `codex_runtime_credential_${randomUUID().replace(/-/g, "")}`;
const adminUrl = new URL(rawUrl);
adminUrl.searchParams.set("schema", "public");
const adminDb = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
let runtimeDb: PrismaClient | null = null;
let schemaWasCreated = false;

async function main() {
try {
  await adminDb.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  schemaWasCreated = true;
  const testUrl = new URL(rawUrl!);
  testUrl.searchParams.set("schema", schema);
  process.env.DATABASE_URL = testUrl.toString();
  execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", env: process.env });

  const [{ db }, { createRuntimeConnectorCredential }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/auth/service-credentials"),
  ]);
  runtimeDb = db as unknown as PrismaClient;
  const workspace = await db.workspace.create({ data: { externalOrganizationId: randomUUID(), name: "Codex isolated runtime credential test" } });
  const project = await db.project.create({ data: { workspaceId: workspace.id, externalProjectId: randomUUID(), name: "Synthetic project" } });
  const site = await db.site.create({ data: { projectId: project.id, domain: `${randomUUID()}.example.test` } });
  await db.connectorBinding.create({ data: { projectId: project.id, siteId: site.id, executor: "helloada", generation: 7 } });

  const principal = await db.servicePrincipal.create({ data: { projectId: project.id, name: "helloada-runtime" } });
  const existingMcp = await db.serviceCredential.create({ data: {
    servicePrincipalId: principal.id,
    tokenPrefix: "cseo_existing",
    tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    issuanceIdempotencyKey: `synthetic-mcp:${randomUUID()}`,
    scopes: ["connector:read"],
  } });

  const request = { siteId: site.id, expectedGeneration: 7, activationPlanHash: "a".repeat(64), idempotencyKey: randomUUID() };
  const first = await createRuntimeConnectorCredential(request);
  if (!first.token || first.reused) throw new Error("First issuance did not deliver a new token");
  const firstToken = first.token;
  const retry = await createRuntimeConnectorCredential(request);
  if (retry.token !== null || !retry.reused || retry.credentialId !== first.credentialId) throw new Error("Same-key retry did not reuse the original credential");
  const issued = await db.serviceCredential.findUniqueOrThrow({ where: { id: first.credentialId } });
  if (JSON.stringify(issued.scopes) !== JSON.stringify(["connector:read", "connector:write"])) throw new Error("Issued credential scopes are not exact");
  const preserved = await db.serviceCredential.findUniqueOrThrow({ where: { id: existingMcp.id } });
  if (preserved.revokedAt !== null) throw new Error("Existing MCP credential was revoked");

  await db.connectorBinding.update({ where: { siteId: site.id }, data: { generation: 8 } });
  let generationConflict = false;
  try { await createRuntimeConnectorCredential({ ...request, expectedGeneration: 8 }); }
  catch (error) { generationConflict = /different request inputs|idempotency key/i.test(error instanceof Error ? error.message : ""); }
  if (!generationConflict) throw new Error("Changed generation did not conflict on the existing idempotency key");

  let hashConflict = false;
  try { await createRuntimeConnectorCredential({ ...request, activationPlanHash: "b".repeat(64), expectedGeneration: 8 }); }
  catch (error) { hashConflict = /different request inputs|idempotency key/i.test(error instanceof Error ? error.message : ""); }
  if (!hashConflict) throw new Error("Changed activation hash did not conflict on the existing idempotency key");

  // Keep the token in local memory through all assertions; never print or persist it.
  if (!firstToken.startsWith("cseo_")) throw new Error("Issued token has an invalid prefix");
  console.log("Isolated PostgreSQL issuance, retry, conflict, exact-scope, and credential-preservation checks passed.");
} finally {
  await runtimeDb?.$disconnect();
  if (schemaWasCreated) {
    await adminDb.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    const rows = await adminDb.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}) AS present`;
    if (rows[0]?.present) throw new Error("Temporary PostgreSQL schema cleanup failed");
  }
  await adminDb.$disconnect();
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Isolated PostgreSQL credential test failed");
  process.exitCode = 1;
});
