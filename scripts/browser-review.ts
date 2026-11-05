/**
 * Seeded browser and accessibility review for the recommendation detail page.
 *
 *   npx tsx scripts/browser-review.ts \
 *     --database-url="postgresql://.../db?schema=csv_validation" \
 *     --out-dir=/tmp/opencode/browser-review
 *
 * It seeds two isolated opportunities (a canonical investigation and an actionable
 * recommendation with multiple benefits/reviews), starts the built app against the
 * disposable schema, and checks desktop/mobile layout plus axe-core violations.
 * The workspace is deleted afterwards. It does not touch the application database.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { chromeExecutable } from "@/lib/agent-tasks/screenshots";
import {
  finaliseDecision,
  sealPacket,
  type EvidencePacket,
  type ModelDecision,
  type RecommendationDecision,
} from "@/lib/recommendation/contracts";
import { projectDecision } from "@/lib/recommendation/projection";
import { assertShadowDatabaseUrl } from "@/lib/recommendation/shadow-destination";

function value(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function packet(input: {
  projectId: string;
  siteId: string;
  domain: string;
  theme: string;
  findingId: string;
  dedupKey: string;
}): EvidencePacket {
  return sealPacket({
    projectId: input.projectId,
    siteId: input.siteId,
    policyVersion: "recommendation-policy/2",
    candidate: {
      findingId: input.findingId,
      findingType: "CONCERN",
      theme: input.theme,
      summary: "A customer question used for the browser review.",
      premise: null,
      observedAt: new Date().toISOString(),
      dedupKey: input.dedupKey,
      sourceIds: [],
    },
    businessFacts: [
      {
        id: "fact:services",
        field: "services",
        value: "fitted wardrobes and bespoke furniture",
        sourceUrl: null,
        provenanceKind: "ai_observation",
        provenanceStatus: "assumed",
        publicationUse: "internal_only",
        documentRevision: null,
      },
    ],
    context: { language: "en", audience: null, market: "United Kingdom", marketSource: "business" },
    sources: [],
    pages: [
      {
        id: "page:review",
        url: `https://${input.domain}/services`,
        title: "Fitted wardrobes",
        contentHash: null,
        text: "We make fitted wardrobes and bespoke furniture. Every project starts with a survey and a written quotation.",
        truncated: false,
        retrieval: "stored",
        status: 200,
        language: "en",
        inspected: 118,
        totalChars: 118,
        offset: 0,
        retrievalNote: null,
        truncation: "none",
        sections: [],
      },
    ],
    links: [],
    requests: [],
    trace: [],
    inventory: [{ url: `https://${input.domain}/services`, title: "Fitted wardrobes", status: 200, indexable: true, retrieval: "stored" }],
    search: [],
    limitations: [],
  });
}

function investigationModel(): ModelDecision {
  return {
    question: {
      text: "What does the owner's private installation ledger require?",
      audience: null,
      journeyStage: null,
      bases: [{ basis: "inferred_need", references: [], note: "The public pages cannot establish the private requirement." }],
      state: "unverified",
      rationale: "Only the owner holds this information.",
    },
    premise: { state: "unverified", rationale: "The private requirement is not public.", references: [] },
    offerFit: { state: "unverified", rationale: "The service is known; the requirement is not.", references: [] },
    coverage: [],
    readiness: "needs_investigation",
    intervention: "investigate",
    change: null,
    assetJustification: null,
    investigation: {
      kind: "owner_input",
      question: "What does the private installation ledger require before a survey?",
      inspect: ["Ask the owner for the private installation checklist."],
      decisionCriteria: ["The owner confirms the checklist and the required deposit."],
      deliverable: "A confirmed installation checklist.",
    },
    targets: [],
    benefits: [],
    effort: { size: "unknown", rationale: "No implementation work until the owner answers.", uncertainty: [] },
    risks: [],
    reviews: [],
    success: { measure: "The owner confirms the checklist.", instrumentation: "unknown", rationale: "No implementation work." },
    uncertainty: [],
    contradictions: [],
    reasons: ["A private owner requirement is unresolved."],
  };
}

function actionableModel(): ModelDecision {
  return {
    question: {
      text: "What does a fitted wardrobe quote include?",
      audience: "A homeowner comparing fitted wardrobes",
      journeyStage: "consideration",
      bases: [{ basis: "inferred_need", references: [], note: "The service page names the offer but not the quote contents." }],
      state: "unverified",
      rationale: "A customer needs to judge the quote before booking a survey.",
    },
    premise: { state: "supported", rationale: "The service page gives a starting price only.", references: ["page:review"] },
    offerFit: { state: "supported", rationale: "Fitted wardrobes are a named service.", references: ["fact:services"] },
    coverage: [
      {
        pageId: "page:review",
        state: "partially_answers",
        scope: "whole_page",
        rationale: "The page gives a starting price but not what the quote includes.",
        excerpts: ["Every project starts with a survey and a written quotation."],
        limitations: [],
      },
    ],
    readiness: "actionable",
    intervention: "update_page",
    change: "Add an itemised quote breakdown (survey, design, materials, delivery and installation) to the service page.",
    assetJustification: null,
    investigation: null,
    targets: [
      {
        pageId: "page:review",
        pageUrl: null,
        sectionId: null,
        role: "update",
        rationale: "The existing service page is the right place for the breakdown.",
      },
    ],
    benefits: [
      {
        track: "customer_value",
        mechanism: "A customer can judge affordability before booking a survey.",
        measurement: "unquantified",
        baselineReference: null,
        assumptions: [],
        uncertainty: ["The frequency of the question is not measured."],
      },
      {
        track: "organic_growth",
        mechanism: "The page becomes a more complete answer to a buying question.",
        measurement: "unquantified",
        baselineReference: null,
        assumptions: [],
        uncertainty: ["No keyword volume is asserted."],
      },
    ],
    effort: { size: "small", rationale: "One section on an existing page.", uncertainty: [] },
    risks: ["The quote must not promise a fixed price before the survey."],
    reviews: [
      { requirement: "subject_matter_expert", reason: "Confirm the quote stages match the installation process." },
      { requirement: "legal", reason: "Check the price validity and cancellation wording." },
    ],
    success: { measure: "A customer can list what the quote includes.", instrumentation: "unknown", rationale: "No analytics change." },
    uncertainty: ["The demand frequency is not measured."],
    contradictions: [],
    reasons: ["The page gives a starting price but not the quote contents."],
  };
}

async function seed(db: PrismaClient, baseUrl: string) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const domain = `browser-review-${suffix}.example`;
  const user = await db.user.create({ data: { email: `browser-review-${suffix}@example.test`, name: "Browser review" } });
  const workspace = await db.workspace.create({
    data: { externalOrganizationId: `browser-review:${suffix}`, name: `Browser review ${suffix}` },
  });
  const project = await db.project.create({
    data: { workspaceId: workspace.id, externalProjectId: `browser-review:${suffix}`, name: "Browser review" },
  });
  const site = await db.site.create({ data: { projectId: project.id, userId: user.id, domain } });
  const sessionToken = `browser-review-${randomUUID()}`;
  await db.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
  });
  const document = await db.businessKnowledgeDocument.create({
    data: { projectId: project.id, logicalId: `browser-review-${suffix}`, revision: 1, acceptedRevision: 1 },
  });
  await db.businessKnowledgeRevision.create({
    data: {
      documentId: document.id,
      revision: 1,
      state: "accepted",
      fields: { services: { value: ["fitted wardrobes", "bespoke furniture"] } },
      reason: "browser review fixture",
      changedFields: {},
      affectedActionIds: [],
      serviceCaller: "browser-review",
    },
  });

  const create = async (theme: string, model: ModelDecision, decisionId: string) => {
    const evidencePacket = packet({
      projectId: project.id,
      siteId: site.id,
      domain,
      theme,
      findingId: decisionId,
      dedupKey: `O13:${decisionId}`,
    });
    const decision: RecommendationDecision = finaliseDecision({
      model,
      packet: evidencePacket,
      modelName: "fixture-model",
      promptVersion: "recommendation-prompt/2",
    });
    const evidence = await db.evidenceRecord.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        kind: "research_finding",
        observedAt: new Date(),
        producer: "browser-review",
        dimensions: { findingId: decisionId, theme, painPoint: "true", recommendationFinalPacketJson: evidencePacket },
        metrics: {},
        observationHash: `browser-review-${suffix}-${decisionId}`,
      },
    });
    const projection = projectDecision({
      decision,
      findingType: "CONCERN",
      projectId: project.id,
      evidenceId: evidence.id,
      evidenceCompleteness: "why",
    });
    const opportunity = await db.opportunity.create({
      data: {
        projectId: project.id,
        type: projection.type,
        dimension: projection.dimension,
        title: projection.title,
        summary: projection.summary,
        dedupKey: projection.dedupKey,
        scoreValue: 30,
        scoreInputs: projection.scoreInputs as never,
        recommendationDecision: decision as never,
        recommendationVersion: projection.recommendationVersion,
        recommendationFingerprint: projection.recommendationFingerprint,
        recommendationEvidenceId: evidence.id,
        detectedBy: "browser-review",
        status: "detected",
      },
    });
    return opportunity.id;
  };

  const investigationId = await create("Private installation requirements", investigationModel(), "investigation");
  const actionableId = await create("Fitted wardrobe quote contents", actionableModel(), "actionable");
  return {
    workspaceId: workspace.id,
    siteId: site.id,
    sessionToken,
    investigationUrl: `${baseUrl}/sites/${site.id}/opportunities/${investigationId}`,
    actionableUrl: `${baseUrl}/sites/${site.id}/opportunities/${actionableId}`,
  };
}

class Cdp {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Map<string, Array<(params: unknown) => void>>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id != null) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "CDP error"));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method: string): Promise<unknown> {
    return new Promise((resolve) => {
      const listener = (params: unknown) => {
        const list = this.listeners.get(method) ?? [];
        this.listeners.set(method, list.filter((entry) => entry !== listener));
        resolve(params);
      };
      this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    });
  }
}

async function connect(port: number): Promise<{ cdp: Cdp; close: () => void }> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
        });
        return { cdp: new Cdp(socket), close: () => socket.close() };
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error("Chromium did not expose a page target");
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`server did not start at ${url}`);
}

async function main() {
  const databaseUrl = value("database-url") ?? process.env.BROWSER_REVIEW_DATABASE_URL ?? null;
  if (!databaseUrl) throw new Error("--database-url or BROWSER_REVIEW_DATABASE_URL is required");
  assertShadowDatabaseUrl(databaseUrl);
  const outDir = value("out-dir") ?? `/tmp/opencode/browser-review-${Date.now()}`;
  mkdirSync(outDir, { recursive: true });
  const port = Number(value("port") ?? 4317);
  const baseUrl = `http://127.0.0.1:${port}/crawlseo`;

  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let server: ChildProcess | null = null;
  let chrome: ChildProcess | null = null;
  let workspaceId: string | null = null;
  try {
    const seeded = await seed(db, baseUrl);
    workspaceId = seeded.workspaceId;

    server = spawn("npm", ["run", "start", "--", "-p", String(port)], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    await waitForServer(`${baseUrl}/login`);

    const chromePath = await chromeExecutable();
    if (!chromePath) throw new Error("no Chromium executable found");
    const profile = mkdtempSync(join(tmpdir(), "browser-review-chrome-"));
    const debugPort = 9400 + Math.floor(Math.random() * 300);
    chrome = spawn(
      chromePath,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: true }
    );
    const { cdp, close } = await connect(debugPort);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCookie", {
      name: "crawlseo.session-token",
      value: seeded.sessionToken,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });

    const axeSource = readFileSync(join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");
    const pages = [
      { name: "investigation", url: seeded.investigationUrl },
      { name: "actionable", url: seeded.actionableUrl },
    ];
    const viewports = [
      { name: "desktop", width: 1440, height: 1200 },
      { name: "mobile", width: 390, height: 844 },
    ];
    const results: Array<Record<string, unknown>> = [];

    for (const page of pages) {
      for (const viewport of viewports) {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: viewport.width < 600,
        });
        const loaded = cdp.once("Page.loadEventFired");
        await cdp.send("Page.navigate", { url: page.url });
        await loaded;
        await sleep(750);

        const layout = await cdp.send<{ result: { value: { scrollWidth: number; innerWidth: number; title: string } } }>(
          "Runtime.evaluate",
          {
            expression:
              "({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, title: document.title })",
            returnByValue: true,
          }
        );
        const axe = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: `${axeSource}\n;axe.run(document, { resultTypes: ["violations"] }).then((r) => JSON.stringify(r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target) }))))`,
          awaitPromise: true,
          returnByValue: true,
        });
        const screenshot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        const screenshotPath = join(outDir, `${page.name}-${viewport.name}.png`);
        writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
        results.push({
          page: page.name,
          viewport: viewport.name,
          url: page.url,
          title: layout.result.value.title,
          overflow: layout.result.value.scrollWidth > layout.result.value.innerWidth,
          axe: JSON.parse(axe.result.value),
          screenshot: screenshotPath,
        });
      }
    }

    const reportPath = join(outDir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          database: databaseUrl.replace(/\/\/[^@]+@/, "//***@"),
          results,
        },
        null,
        2
      )
    );
    const violations = results.flatMap((result) => (result.axe as Array<{ id: string }>).map((entry) => `${result.page}/${result.viewport}: ${entry.id}`));
    const overflows = results.filter((result) => result.overflow).map((result) => `${result.page}/${result.viewport}`);
    process.stdout.write(`\nwrote ${reportPath}\n`);
    if (violations.length || overflows.length) {
      process.stdout.write(`accessibility violations: ${violations.join(", ") || "none"}\n`);
      process.stdout.write(`horizontal overflow: ${overflows.join(", ") || "none"}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("no axe violations and no horizontal overflow\n");
    }
    close();
  } finally {
    const stop = (child: ChildProcess | null) => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    stop(chrome);
    stop(server);
    if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.$disconnect();
    // The detached Next process can keep the event loop alive after SIGTERM.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
