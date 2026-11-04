/**
 * Read-only evaluation of the production recommendation path.
 *
 *   npx tsx scripts/evaluate-need-assessment.ts --domain=www.susimacdonald.com \
 *     --finding="Foreign land ownership" --out=/tmp/opencode/susi.json
 *
 * This is a wrapper around the same packet builder, model assessor and validator
 * the monthly pipeline uses. It does not rank pages, build its own evidence or
 * qualify anything itself. It writes no evidence, opportunity, task or knowledge
 * revision and calls no paid search provider. It does call the configured content
 * model, because mocked reasoning cannot establish SEO judgement.
 */
import { writeFileSync } from "node:fs";

import { db } from "@/lib/db";
import {
  extractBusinessKnowledgeFromPages,
  htmlToText,
} from "@/lib/projects/business-knowledge-extract";
import type { EvidencePacket } from "@/lib/recommendation/contracts";
import { assessFinding } from "@/lib/recommendation/run";
import { validateDecision } from "@/lib/recommendation/contracts";

type Args = {
  domain: string;
  findings: string[];
  maxFindings: number;
  need: string | null;
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
    out: value("out"),
  };
}

async function fetchPage(url: string): Promise<{ url: string; title: string; text: string } | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "CrawlSEO recommendation evaluation (+https://crawlseo.app)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    return { url: response.url || url, title, text: htmlToText(html).slice(0, 6_000) };
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const site = await db.site.findFirst({
    where: { domain: args.domain, retiredAt: null },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site) throw new Error(`no active site for ${args.domain}`);
  if (!site.projectId) throw new Error(`${args.domain} has no project`);

  const findings = (
    await db.evidenceRecord.findMany({
      where: { projectId: site.projectId, siteId: site.id, kind: "research_finding", supersededById: null },
      select: { id: true, dimensions: true, observedAt: true },
      orderBy: { observedAt: "desc" },
    })
  )
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

  const report: Record<string, unknown> = {
    schemaVersion: "recommendation-evaluation/1",
    generatedAt: new Date().toISOString(),
    domain: site.domain,
    projectId: site.projectId,
    findingsSelected: findings.map((row) => String(row.dimensions.theme ?? "(no theme)")),
    extraction: null as unknown,
    assessments: [] as unknown[],
  };

  // A tenant with no knowledge is not blocked: its own pages are the source. The
  // extraction core is the same one the monthly bootstrap uses, run without a write.
  let extractedFacts: EvidencePacket["businessFacts"] = [];
  const knowledge = await db.businessKnowledgeDocument.findUnique({
    where: { projectId: site.projectId },
    select: { id: true },
  });
  if (!knowledge) {
    const crawl = await db.crawl.findFirst({
      where: { siteId: site.id, status: "COMPLETED" },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    });
    const inventory = crawl
      ? await db.auditPage.findMany({ where: { crawlId: crawl.id }, select: { url: true }, take: 10 })
      : [];
    const pages: Array<{ url: string; title: string; text: string }> = [];
    for (const page of inventory) {
      const fetched = await fetchPage(page.url);
      if (fetched) pages.push(fetched);
    }
    if (pages.length === 0) throw new Error(`no page could be retrieved for ${site.domain}`);
    const extracted = await extractBusinessKnowledgeFromPages(pages);
    extractedFacts = Object.entries(extracted.fields as Record<string, unknown>)
      .filter(([field, value]) => field !== "contentLanguage" && value != null)
      .map(([field, value]) => ({
        id: `fact:${field}`,
        field,
        value: Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").join("; ") : String(value),
        sourceUrl: pages[0].url,
        provenanceKind: "ai_observation",
        provenanceStatus: "assumed",
        publicationUse: "internal_only",
        documentRevision: null,
      }))
      .filter((fact) => fact.value.trim().length > 0);
    report.extraction = {
      method: "extractBusinessKnowledgeFromPages (same core as the monthly bootstrap)",
      pagesRead: extracted.pagesRead,
      pageUrls: pages.map((page) => page.url),
      contentLanguage: extracted.contentLanguage,
      extractedFields: extracted.extracted,
      fields: extracted.fields,
      written: false,
    };
    process.stdout.write(`\n=== ${site.domain} :: automatic business-knowledge extraction\n`);
    process.stdout.write(`pages read: ${extracted.pagesRead} (${pages.map((page) => page.url).join(", ")})\n`);
    process.stdout.write(`language: ${extracted.contentLanguage ?? "unknown"}\n`);
    process.stdout.write(`fields: ${extracted.extracted.join(", ") || "none"}\n`);
    process.stdout.write("written: false\n");
  }

  if (findings.length === 0 && args.need) {
    const need = args.need.trim();
    const candidate = {
      findingId: "eval-need",
      dedupKey: `O13:eval:${need.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`,
      findingType: "CONCERN",
      theme: need.slice(0, 120),
      summary: need,
      premise: need,
      observedAt: new Date(),
      sourceIds: [] as string[],
    };
    const assessed = await assessFinding(db, {
      projectId: site.projectId,
      siteId: site.id,
      persist: false,
      force: true,
      businessFacts: extractedFacts.length > 0 ? extractedFacts : undefined,
      finding: {
        id: candidate.findingId,
        runId: "evaluation",
        type: candidate.findingType,
        theme: candidate.theme,
        summary: candidate.summary,
        premise: candidate.premise,
        observedAt: candidate.observedAt,
        sourceIds: candidate.sourceIds,
        dedupKey: candidate.dedupKey,
        dimensions: { painPoint: "true", theme: candidate.theme, painPointSummary: candidate.summary },
      },
    });
    const packet = assessed.packet;
    const validation = assessed.decision && packet ? validateDecision(assessed.decision, packet) : { ok: false, errors: assessed.errors };
    (report.assessments as unknown[]).push({
      finding: { id: candidate.findingId, theme: candidate.theme, summary: candidate.summary, type: candidate.findingType },
      packet: packet ? {
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        limitations: packet.limitations,
        context: packet.context,
        businessFacts: packet.businessFacts,
        sources: packet.sources,
        pages: packet.pages,
        inventory: packet.inventory,
        search: packet.search,
      } : null,
      assessment: assessed.decision,
      validation,
      raw: assessed.raw ?? null,
    });
    process.stdout.write(`\n=== ${site.domain} :: explicit inferred need\n`);
    process.stdout.write(`need: ${need}\n`);
    process.stdout.write(`packet ${packet?.packetHash.slice(0, 16) ?? "none"} · pages ${packet?.pages.length ?? 0} · facts ${packet?.businessFacts.length ?? 0}\n`);
    if (!assessed.decision) process.stdout.write(`assessment failed: ${assessed.errors.join("; ")}\n`);
    else {
      process.stdout.write(`decision: ${assessed.decision.readiness} / ${assessed.decision.intervention}\n`);
      for (const reason of assessed.decision.reasons) process.stdout.write(`  - ${reason}\n`);
      if (!validation.ok) process.stdout.write(`validation errors: ${validation.errors.join("; ")}\n`);
    }
  }

  if (findings.length === 0 && !args.need) {
    process.stdout.write(`\n${site.domain}: no research finding selected, so no recommendation can be made. Nothing was created.\n`);
  }

  for (const finding of findings) {
    const dimensions = finding.dimensions;
    const findingId = typeof dimensions.findingId === "string" ? dimensions.findingId : null;
    const stored = findingId
      ? await db.researchFinding.findUnique({
          where: { id: findingId },
          select: { id: true, runId: true, type: true, theme: true, summary: true, evidenceSourceIds: true, createdAt: true },
        })
      : null;
    if (!stored) {
      process.stdout.write(`\n${site.domain}: finding "${String(dimensions.theme ?? "")}" has no stored research row; skipped.\n`);
      continue;
    }
    const sourceIds = Array.isArray(stored.evidenceSourceIds)
      ? stored.evidenceSourceIds.filter((value): value is string => typeof value === "string")
      : [];
    const theme = stored.theme;
    const summary = String(dimensions.painPointSummary ?? dimensions.gapSummary ?? stored.summary);
    const dedupKey = typeof dimensions.recommendationDedupKey === "string"
      ? dimensions.recommendationDedupKey
      : `${stored.type.toUpperCase().includes("POSITION") ? "O14" : "O13"}:${stored.id}`;

    const assessed = await assessFinding(db, {
      projectId: site.projectId,
      siteId: site.id,
      persist: false,
      force: true,
      businessFacts: extractedFacts.length > 0 ? extractedFacts : undefined,
      finding: {
        id: stored.id,
        runId: stored.runId,
        type: stored.type,
        theme,
        summary,
        premise: summary,
        observedAt: stored.createdAt,
        sourceIds,
        dedupKey,
        dimensions: dimensions as Record<string, string | number | boolean | null>,
      },
    });

    const packet = assessed.packet;
    const validation = assessed.decision && packet ? validateDecision(assessed.decision, packet) : { ok: false, errors: assessed.errors };
    (report.assessments as unknown[]).push({
      finding: { id: stored.id, theme, summary, type: stored.type },
      packet: packet ? {
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        limitations: packet.limitations,
        context: packet.context,
        businessFacts: packet.businessFacts,
        sources: packet.sources,
        pages: packet.pages.map((page) => ({
          id: page.id,
          url: page.url,
          title: page.title,
          retrieval: page.retrieval,
          truncated: page.truncated,
          characters: page.text.length,
          text: page.text,
          sections: page.sections,
        })),
        inventory: packet.inventory,
        search: packet.search,
      } : null,
      assessment: assessed.decision,
      validation,
      raw: assessed.raw ?? null,
    });

    process.stdout.write(`\n=== ${site.domain} :: ${theme}\n`);
    process.stdout.write(`packet ${packet?.packetHash.slice(0, 16) ?? "none"} · pages ${packet?.pages.length ?? 0} · sources ${packet?.sources.length ?? 0} · facts ${packet?.businessFacts.length ?? 0}\n`);
    if (packet && packet.limitations.length > 0) process.stdout.write(`limitations: ${packet.limitations.join(" | ")}\n`);
    if (!assessed.decision) {
      process.stdout.write(`assessment failed: ${assessed.errors.join("; ")}\n`);
      if (assessed.raw) process.stdout.write(`raw: ${JSON.stringify(assessed.raw).slice(0, 2_000)}\n`);
      continue;
    }
    process.stdout.write(`decision: ${assessed.decision.readiness} / ${assessed.decision.intervention} / ${assessed.decision.benefits[0]?.measurement ?? "no benefit"}\n`);
    process.stdout.write(`question: ${assessed.decision.question.text}\n`);
    for (const reason of assessed.decision.reasons) process.stdout.write(`  - ${reason}\n`);
    if (!validation.ok) process.stdout.write(`validation errors: ${validation.errors.join("; ")}\n`);
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
