/**
 * Evaluate the real need-assessment path against live sites.
 *
 *   npx tsx scripts/evaluate-need-assessment.ts --domain=www.susimacdonald.com \
 *     --finding="Foreign land ownership" --out=/tmp/opencode/susi.json
 *
 * What it does, in order, and nothing else:
 *
 *  1. reads the tenant, its findings and its extracted business facts (read-only);
 *  2. selects candidate pages from the crawl inventory, then retrieves their actual
 *     public text — the crawl rows are used for URLs, not as proof of content;
 *  3. if the tenant has no business knowledge, runs the same extraction core the
 *     monthly pipeline uses, without writing a revision;
 *  4. runs the real model assessment for each selected finding;
 *  5. prints the inputs, the retrieved excerpts, the structured assessment and the
 *     resulting decision.
 *
 * It publishes nothing, writes no recommendation, and calls no paid search API. It
 * does call the configured content model, because mocked reasoning cannot show
 * whether the assessment understands a real business.
 */
import { writeFileSync } from "node:fs";

import { db } from "@/lib/db";
import { assessCustomerNeed } from "@/lib/funnel/assess-need";
import {
  extractBusinessKnowledgeFromPages,
  htmlToText,
} from "@/lib/projects/business-knowledge-extract";
import {
  assessNeed,
  loadBusinessFacts,
  type AssessmentFact,
  type AssessmentPage,
  type AssessmentSource,
} from "@/lib/research/need-assessment";
import { contentTerms } from "@/lib/research/page-coverage";

type Args = {
  domain: string;
  findings: string[];
  maxFindings: number;
  maxPages: number;
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
    maxPages: Math.max(1, Math.min(Number(value("max-pages") ?? 6), 10)),
    out: value("out"),
  };
}

async function fetchPage(url: string): Promise<{ url: string; title: string; text: string } | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "CrawlSEO need assessment evaluation (+https://crawlseo.app)" },
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

/**
 * Rank candidate pages by the finding's own subject, not by its whole sentence.
 *
 * The label is the subject ("Abat-jour sur mesure sans page dédiée"); the summary
 * is prose that mentions other pages by name, so weighting it equally would rank a
 * page because the finding said "/shop" rather than because it answers the need.
 * Generic document words are dropped for the same reason: every product URL
 * contains "page", which says nothing about the need.
 */
const RANK_STOPWORDS = new Set([
  "page", "pages", "site", "website", "content", "contenu", "candidate", "candidat",
  "section", "article", "articles", "post", "blog",
]);

function rankTerms(value: string): string[] {
  return contentTerms(value).filter((term) => !RANK_STOPWORDS.has(term));
}

function rank(
  urls: Array<{ url: string; title: string | null }>,
  label: string,
  statement: string
): Array<{ url: string; title: string | null }> {
  const labelTerms = rankTerms(label);
  const statementTerms = rankTerms(statement);
  return urls
    .map((page) => {
      const haystack = `${page.title ?? ""} ${page.url}`
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      const labelMatched = labelTerms.filter((term) => haystack.includes(term)).length;
      const statementMatched = statementTerms.filter((term) => haystack.includes(term)).length;
      return { page, score: labelMatched * 10 + statementMatched };
    })
    .sort((a, b) => b.score - a.score || a.page.url.length - b.page.url.length)
    .map((row) => row.page);
}

function factsFromExtraction(
  fields: Record<string, unknown>,
  sourceUrl: string
): AssessmentFact[] {
  const facts: AssessmentFact[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (field === "contentLanguage") continue;
    const values = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : typeof value === "string" && value.trim()
        ? [value]
        : [];
    if (values.length > 0) {
      facts.push({ field, values, sourceUrl, provenance: "ai_observation/assumed/model" });
    }
  }
  return facts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const site = await db.site.findFirst({
    where: { domain: args.domain, retiredAt: null },
    select: { id: true, domain: true, projectId: true, userId: true },
  });
  if (!site) throw new Error(`no active site for ${args.domain}`);
  if (!site.projectId) throw new Error(`${args.domain} has no project`);

  const crawl = await db.crawl.findFirst({
    where: { siteId: site.id, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, pagesFound: true, maxPages: true, finishedAt: true },
  });
  const inventory = crawl
    ? await db.auditPage.findMany({
        where: { crawlId: crawl.id },
        select: { url: true, title: true },
        take: 500,
      })
    : [];

  const findings = (
    await db.evidenceRecord.findMany({
      where: { projectId: site.projectId, kind: "research_finding", supersededById: null },
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
    schemaVersion: "need-assessment-evaluation/1",
    generatedAt: new Date().toISOString(),
    domain: site.domain,
    projectId: site.projectId,
    crawl: crawl
      ? { pagesFound: crawl.pagesFound, maxPages: crawl.maxPages, finishedAt: crawl.finishedAt?.toISOString() ?? null }
      : null,
    findingsSelected: findings.map((row) => String(row.dimensions.theme ?? "(no theme)")),
    extraction: null as unknown,
    assessments: [] as unknown[],
  };

  let facts = await loadBusinessFacts(db, site.projectId);
  const pageCache = new Map<string, { url: string; title: string; text: string }>();

  const fetchFor = async (urls: string[]) => {
    const pages: Array<{ url: string; title: string; text: string }> = [];
    for (const url of urls) {
      const cached = pageCache.get(url);
      if (cached) {
        pages.push(cached);
        continue;
      }
      const page = await fetchPage(url);
      if (page) {
        pageCache.set(url, page);
        pages.push(page);
      }
    }
    return pages;
  };

  // A tenant with no knowledge is not blocked: its own pages are the source. This is
  // the same extraction core the monthly pipeline calls, run without a write so the
  // evaluation does not change the tenant.
  if (facts.length === 0) {
    const sample = await fetchFor(rank(inventory, "", "").slice(0, 10).map((page) => page.url));
    if (sample.length === 0) throw new Error(`no page could be retrieved for ${site.domain}`);
    const extracted = await extractBusinessKnowledgeFromPages(sample);
    facts = factsFromExtraction(extracted.fields as Record<string, unknown>, sample[0].url);
    report.extraction = {
      method: "extractBusinessKnowledgeFromPages (same core as extractBusinessKnowledgeFromSite)",
      pagesRead: extracted.pagesRead,
      pageUrls: sample.map((page) => page.url),
      contentLanguage: extracted.contentLanguage,
      extractedFields: extracted.extracted,
      fields: extracted.fields,
      factsUsed: facts,
      written: false,
    };
    process.stdout.write(`\n=== ${site.domain} :: automatic business-knowledge extraction\n`);
    process.stdout.write(`pages read: ${extracted.pagesRead} (${sample.map((page) => page.url).join(", ")})\n`);
    process.stdout.write(`language: ${extracted.contentLanguage ?? "unknown"}\n`);
    process.stdout.write(`fields: ${extracted.extracted.join(", ") || "none"}\n`);
    process.stdout.write(`facts: ${JSON.stringify(facts).slice(0, 1_200)}\n`);
    process.stdout.write("written: false (evaluation does not create a knowledge revision)\n");
  }

  if (findings.length === 0) {
    process.stdout.write(`\n${site.domain}: no research finding selected, so no recommendation can be made. Nothing was created.\n`);
  }

  for (const finding of findings) {
    const dimensions = finding.dimensions;
    const label = String(dimensions.theme ?? "");
    const statement = String(dimensions.painPointSummary ?? dimensions.gapSummary ?? "");
    const candidates = rank(inventory, label, statement).slice(0, args.maxPages);
    const root = inventory.find((page) => {
      try {
        return new URL(page.url).pathname === "/";
      } catch {
        return false;
      }
    });
    if (root && !candidates.some((page) => page.url === root.url)) candidates.unshift(root);
    const retrieved = await fetchFor(candidates.map((page) => page.url));

    const findingId = typeof dimensions.findingId === "string" ? dimensions.findingId : null;
    const storedFinding = findingId
      ? await db.researchFinding.findUnique({
          where: { id: findingId },
          select: { evidenceSourceIds: true },
        })
      : null;
    const sourceIds = Array.isArray(storedFinding?.evidenceSourceIds)
      ? storedFinding.evidenceSourceIds.filter((value): value is string => typeof value === "string")
      : [];
    const sourceRows = sourceIds.length
      ? await db.researchSource.findMany({
          where: { id: { in: sourceIds.slice(0, 8) } },
          select: { url: true, title: true, excerpt: true, provider: true },
        })
      : [];
    const sources: AssessmentSource[] = sourceRows.map((row) => ({ ...row, excerpt: row.excerpt ?? null }));

    const pages: AssessmentPage[] = retrieved.map((page) => ({
      url: page.url,
      title: page.title,
      contentText: page.text,
    }));

    const input = {
      statement,
      label,
      audience: null,
      market: null,
      businessFacts: facts,
      pages,
      sources,
      coverageComplete: false,
    };

    let assessment = null as Awaited<ReturnType<typeof assessNeed>> | null;
    let assessmentError: string | null = null;
    try {
      assessment = await assessNeed(input);
    } catch (error) {
      assessmentError = error instanceof Error ? error.message : String(error);
    }

    const decision = assessCustomerNeed({
      label,
      statement,
      clusterSize: 1,
      verification: typeof dimensions.verification === "string" ? dimensions.verification : null,
      verificationReason: typeof dimensions.verificationReason === "string" ? dimensions.verificationReason : null,
      coverageState: typeof dimensions.coverageState === "string" ? dimensions.coverageState : null,
      coveragePage: typeof dimensions.coveragePage === "string" ? dimensions.coveragePage : null,
      coverageComplete: false,
      businessFit: { value: 0.9, source: "knowledge" },
      kind: dimensions.positioningGap === "true" ? "offer" : "need",
      assessment,
    });

    (report.assessments as unknown[]).push({
      finding: {
        id: finding.id,
        theme: label,
        statement,
        verification: dimensions.verification ?? null,
        verificationReason: dimensions.verificationReason ?? null,
      },
      inputs: {
        businessFacts: facts,
        pages: pages.map((page) => ({
          url: page.url,
          title: page.title,
          characters: page.contentText.length,
          excerpt: page.contentText.slice(0, 500),
        })),
        sources: sources.map((source) => ({
          url: source.url,
          title: source.title,
          provider: source.provider,
          excerpt: (source.excerpt ?? "").slice(0, 300),
        })),
      },
      assessment,
      assessmentError,
      decision: {
        readiness: decision.readiness,
        evidenceState: decision.evidenceState,
        intervention: decision.intervention,
        measurement: decision.measurement,
        tracks: decision.tracks,
        review: decision.review,
        targetPages: decision.targetPages,
        change: decision.change,
        expectedBenefit: decision.expectedBenefit,
        successMeasure: decision.successMeasure,
        uncertainty: decision.uncertainty,
        reasons: decision.reasons,
      },
    });

    process.stdout.write(`\n=== ${site.domain} :: ${label}\n`);
    process.stdout.write(`need: ${statement}\n`);
    process.stdout.write(`pages retrieved: ${pages.length} (${pages.map((page) => page.url).join(", ")})\n`);
    process.stdout.write(`sources: ${sources.length}\n`);
    if (assessmentError) process.stdout.write(`assessment failed: ${assessmentError}\n`);
    if (assessment) {
      process.stdout.write(`assessment: need=${assessment.need.state} offerFit=${assessment.offerFit.state} coverage=${assessment.coverage.map((row) => `${row.state}@${row.pageUrl}`).join(" | ") || "none"}\n`);
      process.stdout.write(`  intervention=${assessment.intervention} review=${assessment.review}\n`);
      for (const row of assessment.coverage) {
        if (row.excerpts.length > 0) process.stdout.write(`  quote (${row.pageUrl}): ${row.excerpts[0].slice(0, 240)}\n`);
      }
    }
    process.stdout.write(`decision: ${decision.readiness} / ${decision.intervention} / ${decision.measurement}\n`);
    for (const reason of decision.reasons) process.stdout.write(`  - ${reason}\n`);
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
