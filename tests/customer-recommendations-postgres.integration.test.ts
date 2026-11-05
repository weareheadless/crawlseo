import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { restoreBoardSnapshot, takeBoardSnapshot } from "@/lib/ops/board-snapshot";
import { bridgeFindingsToEvidence } from "@/lib/research/finding-evidence";
import { finaliseDecision, hashPacket } from "@/lib/recommendation/contracts";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { publishDecision } from "@/lib/recommendation/publish";
import { reassessProjectRecommendations } from "@/lib/recommendation/reassess";
import { assessFinding } from "@/lib/recommendation/run";
import { shadowRecommendations } from "@/lib/recommendation/shadow";

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
const isolatedSchema = /[?&]schema=csv_validation(?:&|$)/.test(process.env.DATABASE_URL ?? "");
if (enabled && !isolatedSchema) {
  throw new Error("Refusing to run destructive integration tests outside schema=csv_validation");
}
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

dbDescribe("customer-centred recommendations on a disposable schema", { timeout: 20_000 }, () => {
  afterEach(async () => {
    if (workspaces.size) await db.workspace.deleteMany({ where: { id: { in: [...workspaces] } } });
    workspaces.clear();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("rejects a recorded contradiction and keeps an unassessed legacy finding in backlog", async () => {
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
          verification: "unverified",
          assessmentJson: JSON.stringify({
            premise: { state: "unverified", rationale: "the page does not settle the move question", evidenceUrls: [] },
            need: { state: "supported", rationale: "customers ask before relocating", evidenceUrls: [] },
            offerFit: { state: "supported", rationale: "the business makes fitted wardrobes", evidenceUrls: [] },
            coverage: [{
              pageUrl: `https://customer-rec-${suffix}.example/services`,
              state: "partially_answers",
              method: "semantic",
              matchedTerms: [],
              excerpts: ["Fitted wardrobes are made to measure for each room."],
              note: "it lists the service but not whether a wardrobe can be moved",
            }],
            intervention: "update_page",
            change: "Add a paragraph on dismantling and re-fitting a wardrobe during a move.",
            targetPages: [`https://customer-rec-${suffix}.example/services`],
            expectedBenefit: "A moving customer can judge whether to keep the wardrobe.",
            uncertainty: ["the frequency of the question is not measured"],
            review: "none",
            successMeasure: "A moving customer can answer the question from the page.",
            model: "fixture-model",
            promptVersion: "need-assessment/1",
            assessedAt: "2026-11-04T00:00:00.000Z",
          }),
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
    // A legacy lexical verdict is diagnostic: the row stays visible as explicitly
    // unassessed backlog instead of being silently removed or made actionable.
    const contradictedRow = opportunities.find((row) => row.title === "Fitted wardrobe pricing");
    expect(contradictedRow).toBeTruthy();
    const contradictedWorth = (contradictedRow!.scoreInputs as { worth: Record<string, unknown> }).worth;
    expect(contradictedWorth.readiness).toBe("research_backlog");

    const need = opportunities.find((row) => row.title === "Can a wardrobe be moved house");
    expect(need).toBeTruthy();
    const worth = (need!.scoreInputs as { worth: Record<string, unknown> }).worth;
    expect(worth.readiness).toBe("research_backlog");
    expect(worth.measurement).toBe("unquantified");
  });

  it("persists an assessment and turns it into an actionable recommendation", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const { project, site } = await seedTenant(suffix);

    const document = await db.businessKnowledgeDocument.create({
      data: {
        projectId: project.id,
        logicalId: `assessment-knowledge-${suffix}`,
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
          services: {
            value: ["fitted wardrobes", "bespoke furniture"],
            provenance: {
              kind: "ai_observation",
              sourceId: "crawler-extractor",
              originSystem: "crawlseo",
              originRecordId: "fixture",
              originRevision: null,
              actor: { type: "model", id: "crawler-extractor" },
              status: "assumed",
              recordedAt: "2026-11-04T00:00:00.000Z",
              observedAt: "2026-11-04T00:00:00.000Z",
              evidenceUri: `https://customer-rec-${suffix}.example/services`,
            },
            publicationUse: "internal_only",
          },
        },
        reason: "integration fixture",
        changedFields: {},
        affectedActionIds: [],
        serviceCaller: "integration",
      },
    });

    const run = await db.researchRun.create({
      data: {
        siteId: site.id,
        projectId: project.id,
        title: "Assessment fixture",
        brief: { topics: ["fitted wardrobes"] },
        status: "COMPLETED",
      },
    });
    const finding = await db.researchFinding.create({
      data: {
        runId: run.id,
        type: "CONCERN",
        theme: "Customers cannot tell what a fitted wardrobe costs",
        summary: "Homeowners ask about cost before booking a survey.",
        evidenceSourceIds: [],
      },
    });

    const result = await bridgeFindingsToEvidence(db, {
      projectId: project.id,
      siteId: site.id,
      runId: run.id,
      assess: async (packet) => {
        const page = packet.pages.find((entry) => entry.url.endsWith("/services"))!;
        const model = {
          question: {
            text: "What does a fitted wardrobe cost?",
            audience: "homeowners",
            journeyStage: "consideration",
            bases: [{ basis: "inferred_need" as const, references: [], note: "Homeowners ask about cost before booking a survey" }],
            state: "unverified" as const,
            rationale: "The finding and the service page show that cost is the next question, but no direct customer source is stored.",
          },
          premise: { state: "unverified" as const, rationale: "The finding's absence claim is not what is being tested here.", references: [] },
          offerFit: {
            state: "supported" as const,
            rationale: "The business makes fitted wardrobes.",
            references: ["fact:services"],
          },
          coverage: [{
            pageId: page.id,
            state: "does_not_answer" as const,
            rationale: "The page lists the service but gives no cost range.",
            excerpts: [],
            limitations: [],
          }],
          readiness: "actionable" as const,
          intervention: "update_page" as const,
          change: "Add a price range for a typical fitted wardrobe and what the quote includes.",
          assetJustification: null,
          investigation: null,
          targets: [{ pageId: page.id, pageUrl: page.url, sectionId: null, role: "update" as const, rationale: "The service page is where the question arises." }],
          benefits: [{
            track: "customer_value" as const,
            mechanism: "A homeowner can judge the budget before booking.",
            measurement: "unquantified" as const,
            baselineReference: null,
            assumptions: [],
            uncertainty: ["demand is not measured"],
          }],
          effort: { size: "small" as const, rationale: "One section on an existing page.", uncertainty: [] },
          risks: [],
          reviews: [],
          success: { measure: "A homeowner can state a typical range after reading.", instrumentation: "unavailable" as const, rationale: "No enquiry tracking is connected." },
          uncertainty: ["demand is not measured"],
          contradictions: [],
          reasons: ["A specific existing-page improvement is justified by the service content and the inferred buying question."],
        };
        return {
          kind: "final" as const,
          attempts: 1,
          raw: null,
          decision: finaliseDecision({ model, packet, modelName: "fixture-model", promptVersion: "recommendation-prompt/2" }),
        };
      },
    });

    expect(result.assessed).toBe(1);
    const stored = await db.evidenceRecord.findFirstOrThrow({
      where: { projectId: project.id, kind: "research_finding", supersededById: null },
      select: { dimensions: true },
    });
    expect((stored.dimensions as Record<string, unknown>).recommendationModel).toBe("fixture-model");

    await refreshFunnelForSite(db, site.id, { detectedBy: "integration" });
    const opportunity = await db.opportunity.findFirst({
      where: { projectId: project.id, type: "O13_user_pain_point", title: { contains: "fitted wardrobe" } },
      select: { scoreInputs: true, scoreValue: true, recommendationDecision: true },
    });
    expect(opportunity).toBeTruthy();
    const decision = opportunity!.recommendationDecision as Record<string, any>;
    expect(decision.readiness).toBe("actionable");
    expect(decision.intervention).toBe("update_page");
    expect(decision.change).toContain("price range");
    expect(decision.question.rationale).toContain("next question");
    expect(opportunity!.scoreValue).toBeGreaterThan(0);

    // Shadow reassessment must not change the published board.
    const before = await db.opportunity.findMany({
      where: { projectId: project.id },
      select: { id: true, title: true, status: true, recommendationDecision: true, recommendationFingerprint: true },
      orderBy: { id: "asc" },
    });
    const shadow = await reassessProjectRecommendations(db, {
      projectId: project.id,
      siteId: site.id,
      dryRun: true,
    });
    expect(shadow.current + shadow.stale + shadow.missing).toBeGreaterThan(0);
    const after = await db.opportunity.findMany({
      where: { projectId: project.id },
      select: { id: true, title: true, status: true, recommendationDecision: true, recommendationFingerprint: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
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
        recommendationDecision: { schemaVersion: "test-decision" },
        recommendationVersion: "test-decision/1",
        recommendationFingerprint: "fingerprint-before",
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

    // A new recommendation appears after the snapshot and was never reviewed.
    const newRow = await db.opportunity.create({
      data: {
        projectId: project.id,
        type: "O13_user_pain_point",
        dimension: "content",
        title: "New after snapshot",
        summary: "Not in the reviewed state",
        dedupKey: "O13:new-after-snapshot",
        scoreValue: 10,
        scoreInputs: { worth: { volume: null, ctrAtPosition: null, businessValue: 0.5 } },
        detectedBy: "integration",
      },
    });

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

    const result = await restoreBoardSnapshot(db, path, { all: true });
    expect(result.restored).toBeGreaterThan(0);
    expect(result.conflicts.length).toBe(2);
    expect(result.conflicts.join(" ")).toContain("created after the snapshot");

    const restored = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(restored.title).toBe("Before");
    expect(restored.status).toBe("detected");
    expect(restored.recommendationFingerprint).toBe("fingerprint-before");
    expect((restored.recommendationDecision as { schemaVersion?: string }).schemaVersion).toBe("test-decision");

    const preserved = await db.opportunity.findUniqueOrThrow({ where: { id: decided.id } });
    expect(preserved.title).toBe("Accepted later");
    expect(preserved.decidedBy).toBe("owner-2");

    const createdAfter = await db.opportunity.findUniqueOrThrow({ where: { id: newRow.id } });
    expect(createdAfter.status).toBe("parked");
    expect(createdAfter.parkReason).toBe("rollback_new_row");
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
  it("replays an unchanged decision and invalidates it when a stored dependency changes", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const { project, site } = await seedTenant(suffix);
    // Make the service page long enough that the initial packet supplies a
    // section, so an evidence request genuinely expands the packet.
    const servicesPage = await db.auditPage.findFirstOrThrow({
      where: { crawl: { siteId: site.id }, url: { endsWith: "/services" } },
    });
    await db.auditPage.update({
      where: { id: servicesPage.id },
      data: { contentText: `${servicesPage.contentText ?? ""} ${"More fitted wardrobe detail. ".repeat(800)}` },
    });
    const run = await db.researchRun.create({
      data: { siteId: site.id, projectId: project.id, title: "Replay fixture", brief: { topics: ["wardrobes"] }, status: "COMPLETED" },
    });
    const finding = await db.researchFinding.create({
      data: {
        runId: run.id,
        type: "CONCERN",
        theme: "Fitted wardrobe cost",
        summary: "Homeowners ask what a fitted wardrobe costs.",
        evidenceSourceIds: [],
      },
    });
    await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date("2026-11-04T00:00:00.000Z"),
        producer: "research-runner",
        dimensions: {
          findingId: finding.id,
          findingType: "CONCERN",
          theme: finding.theme,
          painPoint: "true",
          painPointSummary: finding.summary,
        },
        metrics: {},
        observationHash: `replay-${suffix}`,
      },
    });

    const decisionModel = {
      question: {
        text: "What does a fitted wardrobe cost?",
        audience: null,
        journeyStage: null,
        bases: [{ basis: "inferred_need" as const, references: [], note: "A plausible buying question from the service page." }],
        state: "unverified" as const,
        rationale: "The finding and page support a low-risk inferred question.",
      },
      premise: { state: "unverified" as const, rationale: "Not established here.", references: [] },
      offerFit: { state: "unverified" as const, rationale: "No business fact was supplied.", references: [] },
      coverage: [],
      readiness: "no_action" as const,
      intervention: "maintain" as const,
      change: null,
      assetJustification: null,
      investigation: null,
      targets: [],
      benefits: [],
      effort: { size: "unknown" as const, rationale: "No work proposed.", uncertainty: [] },
      risks: [],
      reviews: [],
      success: { measure: "No work proposed.", instrumentation: "unknown" as const, rationale: "No work proposed." },
      uncertainty: [],
      contradictions: [],
      reasons: ["No evidenced improvement."],
    };
    let calls = 0;
    let requestUsed = false;
    const assessor = async (packet: Parameters<typeof finaliseDecision>[0]["packet"]) => {
      calls += 1;
      const page = packet.pages[0];
      if (!requestUsed && page) {
        requestUsed = true;
        return {
          kind: "request" as const,
          attempts: 1,
          raw: { kind: "request_evidence" },
          history: [
            {
              round: 0,
              attempt: 1,
              inputPacketHash: packet.packetHash,
              feedback: null,
              kind: "request_evidence" as const,
              raw: { kind: "request_evidence" },
              responseText: null,
              errors: [],
            },
          ],
          request: {
            kind: "request_evidence" as const,
            requests: [
              {
                type: "page_text" as const,
                target: page.id,
                question: "Read the full service page.",
                whyItMatters: "The price detail may be beyond the supplied section.",
              },
            ],
            rationale: "The initial packet supplied only a section.",
          },
        };
      }
      return {
        kind: "final" as const,
        attempts: 1,
        raw: { kind: "final_decision" },
        decision: finaliseDecision({ model: decisionModel, packet, modelName: "fixture-model", promptVersion: "recommendation-prompt/2" }),
      };
    };
    const candidate = {
      id: finding.id,
      runId: run.id,
      type: finding.type,
      theme: finding.theme,
      summary: finding.summary,
      premise: finding.summary,
      observedAt: finding.createdAt,
      sourceIds: [],
      dedupKey: `O13:${finding.id}`,
      dimensions: { findingId: finding.id, painPoint: "true", theme: finding.theme },
    };

    const first = await assessFinding(db, {
      projectId: project.id,
      siteId: site.id,
      finding: candidate,
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });
    expect(first.status).toBe("assessed");
    expect(first.packet?.packetHash).toBe(first.decision?.packetHash);
    const stored = await db.evidenceRecord.findFirstOrThrow({
      where: { projectId: project.id, kind: "research_finding", supersededById: null },
      select: { dimensions: true },
    });
    const dimensions = stored.dimensions as Record<string, unknown>;
    expect(typeof dimensions.recommendationInitialPacketHash).toBe("string");
    expect(typeof dimensions.recommendationDependenciesJson).toBe("string");
    expect(JSON.parse(dimensions.recommendationAttemptsJson as string).length).toBeGreaterThan(0);

    const second = await assessFinding(db, {
      projectId: project.id,
      siteId: site.id,
      finding: candidate,
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });
    expect(second.status).toBe("reused");
    expect(calls).toBe(2);
    expect(second.packet?.packetHash).toBe(first.decision?.packetHash);

    const page = await db.auditPage.findFirstOrThrow({ where: { crawl: { siteId: site.id } } });
    await db.auditPage.update({
      where: { id: page.id },
      data: { contentText: `${page.contentText ?? ""} A newly added price section changes the stored evidence.` },
    });

    const third = await assessFinding(db, {
      projectId: project.id,
      siteId: site.id,
      finding: candidate,
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });
    expect(third.status).toBe("assessed");
    expect(calls).toBe(3);
  });

  it("persists and reuses a packet above 200k characters", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const { project, site, crawl } = await seedTenant(suffix);
    await db.auditPage.createMany({
      data: Array.from({ length: 500 }, (_, index) => ({
        crawlId: crawl.id,
        url: `https://customer-rec-${suffix}.example/inventory/${index}-${"a".repeat(420)}`,
        title: `Inventory ${index}`,
        statusCode: 200,
        contentText: `Inventory page ${index} describes fitted wardrobes and cost.`,
        hasSchema: true,
      })),
    });
    const run = await db.researchRun.create({
      data: { siteId: site.id, projectId: project.id, title: "Large packet fixture", brief: { topics: ["wardrobes"] }, status: "COMPLETED" },
    });
    const finding = await db.researchFinding.create({
      data: {
        runId: run.id,
        type: "CONCERN",
        theme: "Fitted wardrobe cost",
        summary: "Homeowners ask what a fitted wardrobe costs.",
        evidenceSourceIds: [],
      },
    });
    await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date("2026-11-04T00:00:00.000Z"),
        producer: "research-runner",
        dimensions: { findingId: finding.id, findingType: "CONCERN", theme: finding.theme, painPoint: "true" },
        metrics: {},
        observationHash: `large-${suffix}`,
      },
    });
    const decisionModel = {
      question: {
        text: "What does a fitted wardrobe cost?",
        audience: null,
        journeyStage: null,
        bases: [{ basis: "inferred_need" as const, references: [], note: "A plausible buying question from the service page." }],
        state: "unverified" as const,
        rationale: "The finding and page support a low-risk inferred question.",
      },
      premise: { state: "unverified" as const, rationale: "Not established here.", references: [] },
      offerFit: { state: "unverified" as const, rationale: "No business fact was supplied.", references: [] },
      coverage: [],
      readiness: "no_action" as const,
      intervention: "maintain" as const,
      change: null,
      assetJustification: null,
      investigation: null,
      targets: [],
      benefits: [],
      effort: { size: "unknown" as const, rationale: "No work proposed.", uncertainty: [] },
      risks: [],
      reviews: [],
      success: { measure: "No work proposed.", instrumentation: "unknown" as const, rationale: "No work proposed." },
      uncertainty: [],
      contradictions: [],
      reasons: ["No evidenced improvement."],
    };
    const assessor = async (packet: Parameters<typeof finaliseDecision>[0]["packet"]) => ({
      kind: "final" as const,
      attempts: 1,
      raw: { kind: "final_decision" },
      decision: finaliseDecision({ model: decisionModel, packet, modelName: "fixture-model", promptVersion: "recommendation-prompt/2" }),
    });
    const candidate = {
      id: finding.id,
      runId: run.id,
      type: finding.type,
      theme: finding.theme,
      summary: finding.summary,
      premise: finding.summary,
      observedAt: finding.createdAt,
      sourceIds: [],
      dedupKey: `O13:${finding.id}`,
      dimensions: { findingId: finding.id, painPoint: "true", theme: finding.theme },
    };

    const first = await assessFinding(db, {
      projectId: project.id,
      siteId: site.id,
      finding: candidate,
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });
    expect(first.status).toBe("assessed");
    const stored = await db.evidenceRecord.findFirstOrThrow({
      where: { projectId: project.id, kind: "research_finding", supersededById: null },
      select: { dimensions: true },
    });
    const dimensions = stored.dimensions as Record<string, unknown>;
    const packetJson = dimensions.recommendationFinalPacketJson as string;
    expect(packetJson.length).toBeGreaterThan(200_000);
    const parsed = JSON.parse(packetJson) as { packetHash: string; schemaVersion: string };
    expect(parsed.schemaVersion).toBe("evidence-packet/2");
    expect(hashPacket(parsed as never)).toBe(parsed.packetHash);

    const second = await assessFinding(db, {
      projectId: project.id,
      siteId: site.id,
      finding: candidate,
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });
    expect(second.status).toBe("reused");
    expect(second.packet?.packetHash).toBe(first.decision?.packetHash);
  });

  it("restores the active evidence selection without leaving both generations active", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const { project, site } = await seedTenant(suffix);
    const before = await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date("2026-10-01T00:00:00.000Z"),
        producer: "research-runner",
        dimensions: { findingId: "selection-1", painPoint: "true", theme: "Selection" },
        metrics: {},
        observationHash: `selection-before-${suffix}`,
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "board-evidence-"));
    const path = join(dir, "board.json");
    await takeBoardSnapshot(db, path);

    const after = await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date("2026-11-01T00:00:00.000Z"),
        producer: "research-runner",
        dimensions: { findingId: "selection-2", painPoint: "true", theme: "Selection" },
        metrics: {},
        observationHash: `selection-after-${suffix}`,
      },
    });
    await db.evidenceRecord.update({ where: { id: before.id }, data: { supersededById: after.id } });

    const result = await restoreBoardSnapshot(db, path, { all: true });
    expect(result.conflicts.join(" ")).toContain("created after the snapshot");
    const restoredBefore = await db.evidenceRecord.findUniqueOrThrow({ where: { id: before.id } });
    const restoredAfter = await db.evidenceRecord.findUniqueOrThrow({ where: { id: after.id } });
    expect(restoredBefore.supersededById).toBeNull();
    expect(restoredAfter.supersededById).not.toBeNull();
  });

  it("preserves evidence used by newer accepted human work during rollback", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const { project, site } = await seedTenant(suffix);
    const before = await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date("2026-10-01T00:00:00.000Z"),
        producer: "research-runner",
        dimensions: { findingId: "preserved-1", painPoint: "true", theme: "Preserved" },
        metrics: {},
        observationHash: `preserved-before-${suffix}`,
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "board-preserved-"));
    const path = join(dir, "board.json");
    await takeBoardSnapshot(db, path);

    const acceptedEvidence = await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date("2026-11-01T00:00:00.000Z"),
        producer: "research-runner",
        dimensions: { findingId: "preserved-2", painPoint: "true", theme: "Preserved" },
        metrics: {},
        observationHash: `preserved-after-${suffix}`,
      },
    });
    await db.evidenceRecord.update({ where: { id: before.id }, data: { supersededById: acceptedEvidence.id } });
    await db.opportunity.create({
      data: {
        projectId: project.id,
        type: "O13_user_pain_point",
        dimension: "content",
        title: "Accepted after snapshot",
        summary: "Uses newer evidence",
        dedupKey: `O13:preserved-${suffix}`,
        scoreValue: 10,
        scoreInputs: { worth: { volume: null, ctrAtPosition: null, businessValue: 0.8 } },
        status: "accepted",
        decidedBy: "owner",
        decidedAt: new Date(Date.now() + 1_000),
        recommendationEvidenceId: acceptedEvidence.id,
        detectedBy: "integration",
      },
    });

    const result = await restoreBoardSnapshot(db, path, { all: true });
    const restoredBefore = await db.evidenceRecord.findUniqueOrThrow({ where: { id: before.id } });
    const restoredAfter = await db.evidenceRecord.findUniqueOrThrow({ where: { id: acceptedEvidence.id } });
    expect(restoredBefore.supersededById).toBe(acceptedEvidence.id);
    expect(restoredAfter.supersededById).toBeNull();
    expect(result.conflicts.join(" ")).toContain("preserved newer work");
  });

  it("shadow writes nothing and apply projects the same semantic result", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const { project, site } = await seedTenant(suffix);
    const knowledge = await db.businessKnowledgeDocument.create({
      data: {
        projectId: project.id,
        logicalId: `shadow-knowledge-${suffix}`,
        revision: 1,
        acceptedRevision: 1,
      },
    });
    await db.businessKnowledgeRevision.create({
      data: {
        documentId: knowledge.id,
        revision: 1,
        state: "accepted",
        fields: { services: { value: ["fitted wardrobes"] } },
        reason: "shadow apply fixture",
        changedFields: {},
        affectedActionIds: [],
        serviceCaller: "integration",
      },
    });
    const run = await db.researchRun.create({
      data: {
        siteId: site.id,
        projectId: project.id,
        title: "Shadow apply fixture",
        brief: {},
        status: "COMPLETED",
      },
    });
    const finding = await db.researchFinding.create({
      data: {
        runId: run.id,
        type: "CONCERN",
        theme: "Fitted wardrobe pricing",
        summary: "Customers ask what a fitted wardrobe costs.",
        evidenceSourceIds: [],
      },
    });
    const evidence = await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date("2026-11-01T00:00:00.000Z"),
        producer: "research-runner",
        dimensions: {
          findingId: finding.id,
          painPoint: "true",
          theme: finding.theme,
          recommendationDedupKey: `O13:${finding.id}`,
        },
        metrics: {},
        observationHash: `shadow-apply-${suffix}`,
      },
    });

    const assessor = async (packet: Parameters<typeof finaliseDecision>[0]["packet"]) => {
      const page = packet.pages[0];
      const model = {
        question: {
          text: "What does a fitted wardrobe cost?",
          audience: null,
          journeyStage: null,
          bases: [{ basis: "inferred_need" as const, references: [], note: "The service page supports the question." }],
          state: "unverified" as const,
          rationale: "A plausible buying question.",
        },
        premise: { state: "unverified" as const, rationale: "Not established here.", references: [] },
        offerFit: { state: "supported" as const, rationale: "The business knowledge names fitted wardrobes as a service.", references: ["fact:services"] },
        coverage: page
          ? [
              {
                pageId: page.id,
                state: "partially_answers" as const,
                scope: "whole_page" as const,
                rationale: "The service page gives a starting price but not a full quote breakdown.",
                excerpts: [page.text.slice(0, 200)],
                limitations: [],
              },
            ]
          : [],
        readiness: "actionable" as const,
        intervention: "update_page" as const,
        change: "Add an itemised quote breakdown to the fitted wardrobe service page.",
        assetJustification: null,
        investigation: null,
        targets: page
          ? [
              {
                pageId: page.id,
                pageUrl: page.url,
                sectionId: null,
                role: "update" as const,
                rationale: "The existing service page is the right place for the breakdown.",
              },
            ]
          : [],
        benefits: [
          {
            track: "customer_value" as const,
            mechanism: "A quote breakdown helps a customer judge affordability before booking a survey.",
            measurement: "unquantified" as const,
            baselineReference: null,
            assumptions: [],
            uncertainty: ["The frequency of the question is not measured."],
          },
        ],
        effort: { size: "small" as const, rationale: "One section on an existing page.", uncertainty: [] },
        risks: [],
        reviews: [],
        success: { measure: "A customer can see what the quote includes.", instrumentation: "unknown" as const, rationale: "No analytics change." },
        uncertainty: [],
        contradictions: [],
        reasons: ["The service page only gives a starting price."],
      };
      return {
        kind: "final" as const,
        attempts: 1,
        raw: { kind: "final_decision" },
        decision: finaliseDecision({
          model,
          packet,
          modelName: "fixture-model",
          promptVersion: "recommendation-prompt/2",
        }),
      };
    };

    const before = await db.opportunity.count({ where: { projectId: project.id } });
    const report = await shadowRecommendations(db, {
      projectId: project.id,
      siteId: site.id,
      maxAssessments: "all",
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });
    expect(report.complete).toBe(true);
    expect(report.entries).toHaveLength(1);
    expect(await db.opportunity.count({ where: { projectId: project.id } })).toBe(before);
    const proposed = report.entries[0].proposedDecision;
    const projection = report.entries[0].proposedProjection;
    expect(proposed).not.toBeNull();
    expect(projection).not.toBeNull();

    await publishDecision(db, {
      projectId: project.id,
      decision: proposed!,
      findingType: finding.type,
      evidenceId: evidence.id,
    });
    const applied = await db.opportunity.findUniqueOrThrow({
      where: { projectId_dedupKey: { projectId: project.id, dedupKey: proposed!.dedupKey } },
    });
    expect(applied.title).toBe(projection!.title);
    expect(applied.summary).toBe(projection!.summary);
    expect(applied.type).toBe(projection!.type);
    expect(applied.scoreInputs).toEqual(projection!.scoreInputs);
    expect(applied.recommendationDecision).toMatchObject(projection!.recommendationDecision);
    expect(applied.recommendationEvidenceId).toBe(evidence.id);

    await publishDecision(db, {
      projectId: project.id,
      decision: proposed!,
      findingType: finding.type,
      evidenceId: evidence.id,
    });
    expect(await db.opportunity.count({ where: { projectId: project.id, dedupKey: proposed!.dedupKey } })).toBe(1);
  });

});
