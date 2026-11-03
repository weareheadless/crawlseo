/**
 * DS-04 dual-run harness.
 *
 * The plan requires a bounded dual-run before any read path moves: at least 20
 * pages across 3 approved sites, plus the cases that exercise existing
 * capabilities, with no duplicate writes from the comparison path.
 *
 * This script is the harness for that run. It:
 *   1. ingests a recorded OnPage response into the evidence store (raw payload +
 *      derived page/issue/link evidence),
 *   2. counts our own crawl's issues for the same site,
 *   3. prints the parity report and exits non-zero when parity is not proven.
 *
 * It refuses to run without a recorded response file, because inventing a run
 * would be worse than not running one.
 *
 *   npx tsx scripts/dataforseo-onpage-dual-run.ts --site <siteId> --response <file.json> [--cost-micros 1200]
 */

import { readFile } from "node:fs/promises";

import { PrismaClient } from "@prisma/client";

import { compareCrawlParity, ingestOnPageResponse, type OnPageTaskResponse } from "@/lib/dataforseo/onpage-adapter";

type Args = { siteId: string; responseFile: string; costMicros: bigint };

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    values.set(flag.slice(2), value);
    index += 1;
  }
  const siteId = values.get("site");
  const responseFile = values.get("response");
  if (!siteId) throw new Error("--site <siteId> is required");
  if (!responseFile) {
    throw new Error(
      "--response <file.json> is required: this harness ingests a recorded OnPage response, it does not call the provider"
    );
  }
  const costMicros = BigInt(values.get("cost-micros") ?? "0");
  if (costMicros <= BigInt(0)) {
    throw new Error("--cost-micros must be the provider-reported cost: paid evidence needs recorded provenance");
  }
  return { siteId, responseFile, costMicros };
}

export async function runDualRun(db: PrismaClient, args: Args) {
  const site = await db.site.findUnique({ where: { id: args.siteId }, select: { id: true, domain: true, projectId: true } });
  if (!site) throw new Error(`site not found: ${args.siteId}`);
  if (!site.projectId) throw new Error(`site ${site.domain} is not attached to a project, so it cannot hold funnel evidence`);

  const response = JSON.parse(await readFile(args.responseFile, "utf8")) as OnPageTaskResponse;
  const ingested = await ingestOnPageResponse(db as never, response, {
    projectId: site.projectId,
    siteId: site.id,
    requestedAt: new Date(),
    costMicros: args.costMicros,
  });

  // Our side: the latest completed crawl for the same site.
  const crawl = await db.crawl.findFirst({
    where: { siteId: site.id, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, pagesFound: true, issuesFound: true },
  });
  if (!crawl) throw new Error(`no completed crawl for ${site.domain}: nothing to compare against`);

  // Compare the same URLs. Counting our issues across the whole crawl against the
  // provider's sample compares sample sizes, not detectors: a 200-page crawl will
  // always show issue types a 25-page sample never reached.
  const providerUrls = new Set(
    (response.result ?? []).flatMap((result) => (result.items ?? []).map((item) => item.url)).filter((url): url is string => Boolean(url))
  );
  const ourIssueRows = await db.crawlIssue.groupBy({
    by: ["type"],
    where: { crawlId: crawl.id, ...(providerUrls.size > 0 ? { url: { in: [...providerUrls] } } : {}) },
    _count: { _all: true },
  });
  const ourIssues: Record<string, number> = {};
  for (const row of ourIssueRows) ourIssues[row.type] = row._count._all;

  const providerIssueRows = await db.evidenceRecord.findMany({
    where: {
      projectId: site.projectId,
      siteId: site.id,
      kind: "onpage_crawl",
      producer: "dataforseo",
      rawResponseId: ingested.rawResponseId,
    },
    select: { dimensions: true },
  });
  const providerIssues: Record<string, number> = {};
  for (const row of providerIssueRows) {
    const issueType = (row.dimensions as { issueType?: string } | null)?.issueType;
    if (!issueType) continue;
    providerIssues[issueType] = (providerIssues[issueType] ?? 0) + 1;
  }

  const report = compareCrawlParity({
    providerIssues,
    ourIssues,
    providerPages: ingested.pages,
    ourPages: providerUrls.size,
  });

  return { site: site.domain, ingested, report };
}

if (process.argv[1]?.endsWith("dataforseo-onpage-dual-run.ts")) {
  const db = new PrismaClient();
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const result = await runDualRun(db, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.report.parityProven) {
      process.stderr.write(
        "Parity NOT proven: do not switch read paths. Resolve oursOnly issue types and reach the page minimum first.\n"
      );
      process.exitCode = 2;
    }
  })()
    .catch((error) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
