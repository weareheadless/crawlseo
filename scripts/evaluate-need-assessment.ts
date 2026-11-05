/**
 * Read-only evaluation of the production recommendation path.
 *
 *   npx tsx scripts/evaluate-need-assessment.ts --domain=www.example.com \
 *     --finding="Foreign land ownership" --out=/tmp/opencode/susi.json
 *
 *   npx tsx scripts/evaluate-need-assessment.ts --domain=www.example.com \
 *     --fresh --out=/tmp/opencode/fresh.json
 *
 * `--finding` is a regression selector: it re-runs the analysis for stored findings.
 * `--fresh` re-synthesises candidates from the latest run's stored source
 * observations (no provider calls) and then analyses them, so the candidate is not
 * supplied by an operator. `--need` exists only for a labelled inferred-need probe.
 *
 * This wrapper calls the same packet builder, model assessor, evidence loop and
 * validator as production. It writes no evidence, opportunity, task or knowledge
 * revision, and calls no paid search provider. It does call the configured content
 * model because mocked reasoning cannot establish SEO judgement.
 */
import { writeFileSync } from "node:fs";

import { db } from "@/lib/db";
import { ensureTenantAnalysis } from "@/lib/tenants/analysis";
import { buildPageInventory } from "@/lib/research/page-inventory";
import { synthesizeResearch } from "@/lib/research/synthesizer";
import { assessFinding } from "@/lib/recommendation/run";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { validateDecision, type EvidencePacket } from "@/lib/recommendation/contracts";

type Args = {
  domain: string;
  findings: string[];
  maxFindings: number;
  need: string | null;
  fresh: boolean;
  out: string | null;
};

function parseArgs(argv: string[]): Args {
  const value = (name: string) => {
    const prefix = `--${name}=`;
    return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
  };
  const all = (name: string) =>
    argv.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));
  const domain = value("domain");
  if (!domain) throw new Error("--domain is required");
  return {
    domain,
    findings: all("finding"),
    maxFindings: Math.max(1, Math.min(Number(value("max-findings") ?? 3), 6)),
    need: value("need"),
    fresh: argv.includes("--fresh"),
    out: value("out"),
  };
}

function factsFromExtraction(
  fields: Record<string, unknown>,
  pagesRead: string[]
): EvidencePacket["businessFacts"] {
  const facts: EvidencePacket["businessFacts"] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (field === "contentLanguage" || value == null) continue;
    const text = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string").join("; ")
      : String(value);
    if (!text.trim()) continue;
    facts.push({
      id: `fact:${field}`,
      field,
      value: text,
      // The extractor reads several pages. Without per-value attribution, the
      // honest source is absent rather than the first page in the list.
      sourceUrl: null,
      provenanceKind: "ai_observation",
      provenanceStatus: "assumed",
      publicationUse: "internal_only",
      documentRevision: null,
    });
  }
  void pagesRead;
  return facts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const site = await db.site.findFirst({
    where: { domain: args.domain, retiredAt: null },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site) throw new Error(`no active site for ${args.domain}`);
  if (!site.projectId) throw new Error(`${args.domain} has no project`);
  const projectId = site.projectId;

  const report: Record<string, unknown> = {
    schemaVersion: "recommendation-evaluation/2",
    generatedAt: new Date().toISOString(),
    mode: args.fresh ? "fresh_synthesis" : args.need ? "inferred_need_probe" : "stored_findings",
    domain: site.domain,
    projectId,
    extraction: null as unknown,
    candidates: [] as unknown[],
    assessments: [] as unknown[],
  };

  // Missing or empty knowledge is not a blocker: the same tenant bootstrap the
  // monthly path uses reads the site itself. `dryRun` keeps evaluation read-only.
  let extractedFacts: EvidencePacket["businessFacts"] = [];
  const bootstrap = await ensureTenantAnalysis(db, site.id, { dryRun: true });
  const extracted = bootstrap.extraction ?? null;
  if (extracted) {
    extractedFacts = factsFromExtraction(extracted.fields as Record<string, unknown>, extracted.pageUrls);
    report.extraction = {
      method: "ensureTenantAnalysis (dry run, same orchestration as the monthly bootstrap)",
      pagesRead: extracted.pagesRead,
      pageUrls: extracted.pageUrls,
      contentLanguage: extracted.contentLanguage,
      extractedFields: extracted.extracted,
      fields: extracted.fields,
      written: false,
    };
    process.stdout.write(`\n=== ${site.domain} :: automatic business-knowledge extraction\n`);
    process.stdout.write(`pages read: ${extracted.pagesRead} (${extracted.pageUrls.join(", ")})\n`);
    process.stdout.write(`language: ${extracted.contentLanguage ?? "unknown"}\n`);
    process.stdout.write(`fields: ${extracted.extracted.join(", ") || "none"}\n`);
    process.stdout.write("written: false\n");
  }

  type Candidate = {
    id: string;
    runId: string;
    type: string;
    theme: string;
    summary: string;
    sourceIds: string[];
    observedAt: Date;
    dedupKey: string;
  };
  const candidates: Candidate[] = [];

  if (args.fresh) {
    const run = await db.researchRun.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, topics: true },
    });
    if (!run) throw new Error("no research run exists to re-synthesise from");
    const sources = await db.researchSource.findMany({
      where: { runId: run.id },
      select: { id: true, provider: true, url: true, title: true, community: true, publishedAt: true, excerpt: true },
    });
    if (sources.length === 0) throw new Error("the latest research run has no stored sources");
    const crawl = await db.crawl.findFirst({
      where: { siteId: site.id, status: "COMPLETED" },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    });
    const pages = crawl
      ? await db.auditPage.findMany({
          where: { crawlId: crawl.id },
          select: { url: true, title: true, contentScore: true, h1s: true, description: true },
        })
      : [];
    const inventory = buildPageInventory(pages.map((page) => ({ url: page.url, contentScore: page.contentScore })));
    const synthesis = await synthesizeResearch({
      siteDomain: site.domain,
      title: run.title,
      topics: Array.isArray(run.topics) ? run.topics.filter((topic): topic is string => typeof topic === "string") : [],
      questions: [],
      sources: sources.map((source) => ({
        provider: source.provider,
        url: source.url,
        title: source.title,
        community: source.community,
        publishedAt: source.publishedAt,
        excerpt: source.excerpt,
      })),
      candidatePages: inventory.sampled,
      pageTypes: inventory.groups.map((group) => ({ type: group.type, pages: group.pages, sample: group.samples[0] })),
      pageSummaries: pages
        .filter((page) => inventory.sampled.includes(page.url))
        .map((page) => ({
          url: page.url,
          type: inventory.groups.find((group) => group.samples.includes(page.url))?.type ?? "other",
          title: page.title,
          h1s: Array.isArray(page.h1s) ? page.h1s.filter((value): value is string => typeof value === "string") : [],
          description: page.description,
        })),
    });
    report.synthesis = {
      model: synthesis.model,
      findings: synthesis.findings.map((finding) => ({
        type: finding.type,
        theme: finding.theme,
        summary: finding.summary,
        sourceIndexes: finding.sourceIndexes,
      })),
      rejected: synthesis.rejected,
    };
    for (const [index, finding] of synthesis.findings.slice(0, args.maxFindings).entries()) {
      const sourceIds = finding.sourceIndexes
        .map((sourceIndex) => sources[sourceIndex]?.id)
        .filter((id): id is string => Boolean(id));
      candidates.push({
        id: `fresh-${run.id}-${index}`,
        runId: run.id,
        type: finding.type,
        theme: finding.theme,
        summary: finding.summary,
        sourceIds,
        observedAt: new Date(),
        dedupKey: `O13:fresh:${finding.theme.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`,
      });
    }
  } else if (args.need) {
    const need = args.need.trim();
    candidates.push({
      id: "eval-need",
      runId: "evaluation",
      type: "CONCERN",
      theme: need.slice(0, 120),
      summary: need,
      sourceIds: [],
      observedAt: new Date(),
      dedupKey: `O13:eval:${need.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`,
    });
  } else {
    const rows = await db.evidenceRecord.findMany({
      where: { projectId, siteId: site.id, kind: "research_finding", supersededById: null },
      select: { id: true, dimensions: true, observedAt: true },
      orderBy: { observedAt: "desc" },
    });
    const selected = rows
      .map((row) => ({ ...row, dimensions: (row.dimensions ?? {}) as Record<string, unknown> }))
      .filter((row) =>
        args.findings.length === 0
          ? true
          : args.findings.some((needle) =>
              `${String(row.dimensions.theme ?? "")} ${String(row.dimensions.painPointSummary ?? row.dimensions.gapSummary ?? "")}`
                .toLowerCase()
                .includes(needle.toLowerCase())
            )
      )
      .slice(0, args.maxFindings);
    for (const row of selected) {
      const findingId = typeof row.dimensions.findingId === "string" ? row.dimensions.findingId : null;
      const stored = findingId
        ? await db.researchFinding.findUnique({
            where: { id: findingId },
            select: { id: true, runId: true, type: true, theme: true, summary: true, evidenceSourceIds: true, createdAt: true },
          })
        : null;
      if (!stored) continue;
      const sourceIds = Array.isArray(stored.evidenceSourceIds)
        ? stored.evidenceSourceIds.filter((value): value is string => typeof value === "string")
        : [];
      candidates.push({
        id: stored.id,
        runId: stored.runId,
        type: stored.type,
        theme: stored.theme,
        summary: String(row.dimensions.painPointSummary ?? row.dimensions.gapSummary ?? stored.summary),
        sourceIds,
        observedAt: stored.createdAt,
        dedupKey: typeof row.dimensions.recommendationDedupKey === "string"
          ? row.dimensions.recommendationDedupKey
          : `${stored.type.toUpperCase().includes("POSITION") ? "O14" : "O13"}:${stored.id}`,
      });
    }
  }

  report.candidates = candidates.map((candidate) => ({
    id: candidate.id,
    type: candidate.type,
    theme: candidate.theme,
    summary: candidate.summary,
    sourceIds: candidate.sourceIds,
  }));

  const ledger = new AnalysisLedger();
  for (const candidate of candidates) {
    const assessed = await assessFinding(db, {
      projectId,
      siteId: site.id,
      persist: false,
      force: true,
      businessFacts: extractedFacts.length > 0 ? extractedFacts : undefined,
      ledger,
      finding: {
        id: candidate.id,
        runId: candidate.runId,
        type: candidate.type,
        theme: candidate.theme,
        summary: candidate.summary,
        premise: candidate.summary,
        observedAt: candidate.observedAt,
        sourceIds: candidate.sourceIds,
        dedupKey: candidate.dedupKey,
        dimensions: { painPoint: "true", theme: candidate.theme, painPointSummary: candidate.summary },
      },
    });
    const packet = assessed.packet;
    const validation =
      assessed.decision && packet ? validateDecision(assessed.decision, packet) : { ok: false, errors: assessed.errors };
    (report.assessments as unknown[]).push({
      finding: { id: candidate.id, theme: candidate.theme, summary: candidate.summary, type: candidate.type },
      packet: packet
        ? {
            packetId: packet.packetId,
            packetHash: packet.packetHash,
            limitations: packet.limitations,
            context: packet.context,
            businessFacts: packet.businessFacts,
            sources: packet.sources,
            pages: packet.pages,
            links: packet.links,
            trace: packet.trace,
            inventory: packet.inventory,
            search: packet.search,
          }
        : null,
      assessment: assessed.decision,
      validation,
      analysis: assessed.ledger,
      raw: assessed.raw ?? null,
    });

    process.stdout.write(`\n=== ${site.domain} :: ${candidate.theme}\n`);
    process.stdout.write(
      `packet ${packet?.packetHash.slice(0, 16) ?? "none"} · pages ${packet?.pages.length ?? 0} · sources ${packet?.sources.length ?? 0} · facts ${packet?.businessFacts.length ?? 0}\n`
    );
    if (packet && packet.limitations.length > 0) process.stdout.write(`limitations: ${packet.limitations.join(" | ")}\n`);
    if (!assessed.decision) {
      process.stdout.write(`assessment failed: ${assessed.errors.join("; ")}\n`);
      if (assessed.raw) process.stdout.write(`raw: ${JSON.stringify(assessed.raw).slice(0, 2_000)}\n`);
      continue;
    }
    process.stdout.write(
      `decision: ${assessed.decision.readiness} / ${assessed.decision.intervention} / ${assessed.decision.benefits[0]?.measurement ?? "no benefit"}\n`
    );
    process.stdout.write(`question: ${assessed.decision.question.text}\n`);
    for (const reason of assessed.decision.reasons) process.stdout.write(`  - ${reason}\n`);
    if (!validation.ok) process.stdout.write(`validation errors: ${validation.errors.join("; ")}\n`);
  }

  if (candidates.length === 0) {
    process.stdout.write(`\n${site.domain}: no candidate was produced, so no recommendation can be made. Nothing was created.\n`);
  }

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    process.stdout.write(`\nwrote ${args.out}\n`);
  }
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
