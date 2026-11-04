import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { restoreBoardSnapshot, takeBoardSnapshot } from "@/lib/ops/board-snapshot";

/**
 * Database integration for the customer-centred brief (§6, §7).
 *
 * Runs against a disposable schema (`csv_validation`), never the application
 * schema. It proves the behaviour on real rows: a legacy finding is re-verified,
 * a contradicted premise stops producing an opportunity, a supported need produces
 * an actionable one without any keyword volume, and a rollback preserves a newer
 * human decision.
 *
 *   DATABASE_URL=...?schema=csv_validation RUN_CUSTOMER_REC_DB_TESTS=1 npx vitest run ...
 */
const enabled = process.env.RUN_CUSTOMER_REC_DB_TESTS === "1";
const dbDescribe = enabled ? describe : describe.skip;

const workspaces = new Set<string>();

async function seedTenant(suffix: string) {
  const workspace = await db.workspace.create({
    data: { externalOrganizationId: `customer-rec:${suffix}`, name: `Customer rec ${suffix}` },
  });
  workspaces.add(workspace.id);
  const project = await db.project.create({
    data: { workspaceId: workspace.id, externalProjectId: `customer-rec:${suffix}`, name: "Customer rec" },
  });
  const site = await db.site.create({
    data: { projectId: project.id, domain: `customer-rec-${suffix}.example` },
  });
  const crawl = await db.crawl.create({
    data: { siteId: site.id, status: "COMPLETED", pagesFound: 4, maxPages: 500, startedAt: new Date(), finishedAt: new Date() },
  });
  await db.auditPage.createMany({
    data: [
      {
        crawlId: crawl.id,
        url: `https://customer-rec-${suffix}.example/services`,
        title: "Fitted wardrobes and bespoke furniture",
        statusCode: 200,
        contentText:
          "We make fitted wardrobes, staircases and bespoke furniture. Fitted wardrobes cost from 1200 pounds and every project starts with a survey and a written quotation that sets out the cost. Fitted wardrobes are made to measure for each room.",
        hasSchema: true,
      },
      {
        crawlId: crawl.id,
        url: `https://customer-rec-${suffix}.example/cities/tulum`,
        title: "Tulum market analysis",
        statusCode: 200,
        contentText: "Tulum city market analysis with prices by neighbourhood and a comparison of districts.",
        hasSchema: true,
      },
      {
        crawlId: crawl.id,
        url: `https://customer-rec-${suffix}.example/cities/cancun`,
        title: "Cancun market analysis",
        statusCode: 200,
        contentText: "Cancun city market analysis.",
        hasSchema: true,
      },
      {
        crawlId: crawl.id,
        url: `https://customer-rec-${suffix}.example/cities/cozumel`,
        title: "Cozumel market analysis",
        statusCode: 200,
        contentText: "Cozumel city market analysis.",
        hasSchema: true,
      },
    ],
  });
  return { workspace, project, site, crawl };
}

dbDescribe("customer-centred recommendations on a disposable schema", () => {
  afterEach(async () => {
    if (workspaces.size) await db.workspace.deleteMany({ where: { id: { in: [...workspaces] } } });
    workspaces.clear();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("rejects a contradicted legacy premise and keeps a supported need actionable", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const { project, site } = await seedTenant(suffix);

    // A legacy finding with no verification, claiming an answer that exists.
    await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date("2026-10-01T00:00:00.000Z"),
        producer: "research-runner",
        dimensions: {
          findingId: "legacy-1",
          findingType: "CONTENT_GAP",
          theme: "Fitted wardrobe pricing",
          title: "Fitted wardrobe pricing",
          painPoint: "true",
          painPointSummary: "The site has no page explaining what fitted wardrobes cost or how a quote works.",
          query: null,
        },
        metrics: { "first_party:confidence": { value: 70, unit: "score", source: "first_party" } },
        observationHash: `legacy-${suffix}`,
      },
    });

    // A supported need whose page partly answers it.
    await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date("2026-10-01T00:00:00.000Z"),
        producer: "research-runner",
        dimensions: {
          findingId: "legacy-2",
          findingType: "CONCERN",
          theme: "Can a wardrobe be moved house",
          title: "Can a wardrobe be moved house",
          painPoint: "true",
          painPointSummary: "Customers ask whether a fitted wardrobe can be moved to a new house when they relocate.",
          query: null,
        },
        metrics: { "first_party:confidence": { value: 60, unit: "score", source: "first_party" } },
        observationHash: `legacy2-${suffix}`,
      },
    });

    const document = await db.businessKnowledgeDocument.create({
      data: {
        projectId: project.id,
        logicalId: `knowledge-${suffix}`,
        revision: 1,
        acceptedRevision: 1,
      },
    });
    await db.businessKnowledgeRevision.create({
      data: {
        documentId: document.id,
        revision: 1,
        state: "accepted",
        fields: {
          services: { value: ["fitted wardrobes", "bespoke furniture"] },
          market: { value: "United Kingdom" },
        },
        reason: "integration fixture",
        changedFields: {},
        affectedActionIds: [],
        serviceCaller: "integration",
      },
    });

    await refreshFunnelForSite(db, site.id, { detectedBy: "integration" });

    const findings = await db.evidenceRecord.findMany({
      where: { projectId: project.id, kind: "research_finding", supersededById: null },
      select: { dimensions: true },
    });
    const byTheme = new Map(findings.map((row) => [(row.dimensions as { theme?: string }).theme, row.dimensions as Record<string, unknown>]));
    const contradicted = byTheme.get("Fitted wardrobe pricing");
    expect(contradicted?.verification).toBe("contradicted");

    const opportunities = await db.opportunity.findMany({
      where: { projectId: project.id, status: "detected" },
      select: { type: true, title: true, scoreValue: true, scoreInputs: true },
    });
    // The contradicted premise produces no customer-need opportunity at all.
    expect(opportunities.find((row) => row.title === "Fitted wardrobe pricing")).toBeUndefined();

    const need = opportunities.find((row) => row.title === "Can a wardrobe be moved house");
    expect(need).toBeTruthy();
    const worth = (need!.scoreInputs as { worth: Record<string, unknown> }).worth;
    expect(worth.readiness).toBe("actionable");
    expect(worth.measurement).toBe("unquantified");
    expect(need!.scoreValue).toBeGreaterThan(0);
  });

  it("restores the board without overwriting a newer human decision", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const { project, site } = await seedTenant(suffix);
    const opportunity = await db.opportunity.create({
      data: {
        projectId: project.id,
        type: "O13_user_pain_point",
        dimension: "content",
        title: "Before",
        summary: "Before the reanalysis",
        dedupKey: "O13:rollback-fixture",
        scoreValue: 10,
        scoreInputs: { worth: { volume: null, ctrAtPosition: null, businessValue: 0.9 } },
        detectedBy: "integration",
      },
    });
    const decided = await db.opportunity.create({
      data: {
        projectId: project.id,
        type: "O13_user_pain_point",
        dimension: "content",
        title: "Accepted work",
        summary: "A person accepted this",
        dedupKey: "O13:accepted-fixture",
        scoreValue: 10,
        scoreInputs: { worth: { volume: null, ctrAtPosition: null, businessValue: 0.9 } },
        detectedBy: "integration",
        status: "accepted",
        decidedBy: "owner",
      },
    });

    const dir = mkdtempSync(join(tmpdir(), "board-snapshot-"));
    const path = join(dir, "board.json");
    await takeBoardSnapshot(db, path);

    // A reanalysis changes the published state.
    await db.opportunity.update({
      where: { id: opportunity.id },
      data: { title: "After", summary: "After the reanalysis", scoreValue: 3, status: "parked", parkReason: "superseded" },
    });
    // A human then accepts work, after the snapshot.
    await db.opportunity.update({
      where: { id: decided.id },
      data: { title: "Accepted later", decidedBy: "owner-2", decidedAt: new Date(Date.now() + 1000) },
    });

    const result = await restoreBoardSnapshot(db, path);
    expect(result.restored).toBeGreaterThan(0);
    expect(result.conflicts.length).toBe(1);

    const restored = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(restored.title).toBe("Before");
    expect(restored.status).toBe("detected");

    const preserved = await db.opportunity.findUniqueOrThrow({ where: { id: decided.id } });
    expect(preserved.title).toBe("Accepted later");
    expect(preserved.decidedBy).toBe("owner-2");
    void site;
  });

  it("refuses a snapshot whose checksum does not match", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    await seedTenant(suffix);
    const dir = mkdtempSync(join(tmpdir(), "board-snapshot-"));
    const path = join(dir, "board.json");
    await takeBoardSnapshot(db, path);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.sites = [];
    writeFileSync(path, JSON.stringify(parsed));
    await expect(restoreBoardSnapshot(db, path)).rejects.toThrow(/checksum/);
  });
});
