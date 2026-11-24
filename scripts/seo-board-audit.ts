/**
 * CMP-011, SEO half: can a person actually act on this board?
 *
 * Read-only. Per active site, for every live opportunity, answers the questions an
 * SEO asks before touching a ticket:
 *
 *   - does it name a page, and is that page real right now?
 *   - does it name the query it competes for, or is the key an opaque hash?
 *   - is its demand a measurement or a hypothesis the UI must not present as fact?
 *   - is it filed under a topic?
 *   - is it our own brand term?
 *   - is there an outcome to check later?
 *
 * Counts only, no tenant names in the code, and it exits non-zero on a violation so
 * this becomes a failing check instead of an opinion.
 *
 *   npx tsx scripts/seo-board-audit.ts --all
 *   npx tsx scripts/seo-board-audit.ts --site <siteId>
 */

import { loadEnvConfig } from "@next/env";

import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());

import { brandTermsFromDomain, isBrandQuery } from "@/lib/funnel/detectors";

const LIVE_STATUS = ["detected", "accepted", "in_progress"] as const;

export type BoardAudit = {
  site: string;
  live: number;
  namesTarget: number;
  newAsset: number;
  targetAbsentFromCrawl: number;
  targetNon200: number;
  anchorsQuery: number;
  queryInKey: number;
  opaqueKey: number;
  noQueryAnywhere: number;
  demandMeasured: number;
  demandUnmeasured: number;
  clustered: number;
  brandOnly: number;
  hasOutcome: number;
  /**
   * CMP-012: how many live rows carry a measured winnability input, and how many carry
   * none. This is the number the ticket asks to report before and after: a board where
   * every row is `0 of 4 measured` cannot tell a fair fight from a hopeless one.
   */
  winnabilityMeasured: number;
  winnabilityAssumed: number;
  /** Inputs measured across the live board, by name, so the gap is visible per input. */
  winnabilityByInput: Record<string, number>;
  violations: string[];
};

/** A URL compared without its trailing slash, which is not a different page. */
const norm = (url: string) => url.replace(/\/+$/, "").toLowerCase();

/** Is this query just our own brand? Compared on the brand terms the project declares. */
function isBrandOnly(query: string, brandTerms: string[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const brandWords = new Set(brandTerms.flatMap((term) => term.toLowerCase().split(/\s+/)).filter(Boolean));
  return words.every((word) => brandWords.has(word));
}

function queryFromKey(dedupKey: string): string | null {
  const parts = dedupKey.split(":");
  const candidate = (parts[1] ?? "").trim();
  // A hash segment is not a query; requiring a space keeps opaque ids out.
  if (candidate === "" || !candidate.includes(" ") || candidate.length > 200) return null;
  return candidate;
}

async function auditSite(db: PrismaClient, siteId: string): Promise<BoardAudit> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { domain: true, projectId: true },
  });
  if (!site?.projectId) {
    return { site: site?.domain ?? siteId, live: 0, namesTarget: 0, newAsset: 0, targetAbsentFromCrawl: 0, targetNon200: 0, anchorsQuery: 0, queryInKey: 0, opaqueKey: 0, noQueryAnywhere: 0, demandMeasured: 0, demandUnmeasured: 0, clustered: 0, brandOnly: 0, hasOutcome: 0, winnabilityMeasured: 0, winnabilityAssumed: 0, winnabilityByInput: {}, violations: [] };
  }

  const opportunities = await db.opportunity.findMany({
    where: { projectId: site.projectId, status: { in: [...LIVE_STATUS] } },
    select: {
      type: true,
      dedupKey: true,
      clusterId: true,
      recommendationDecision: true,
      scoreInputs: true,
    },
  });

  // Queries the rows cite, in one read rather than one per opportunity.
  const citedIds = [...new Set(
    opportunities.flatMap((opportunity) => {
      const refs = ((opportunity.recommendationDecision ?? {}) as { evidenceRefs?: unknown }).evidenceRefs;
      return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
    })
  )];
  const citedRows = citedIds.length
    ? await db.evidenceRecord.findMany({ where: { id: { in: citedIds } }, select: { id: true, dimensions: true } })
    : [];
  const queryByEvidenceId = new Map<string, string>();
  for (const row of citedRows) {
    const query = (row.dimensions as { query?: unknown })?.query;
    if (typeof query === "string" && query.trim() !== "") queryByEvidenceId.set(row.id, query);
  }

  const crawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  const crawled = crawl
    ? await db.auditPage.findMany({ where: { crawlId: crawl.id }, select: { url: true, statusCode: true } })
    : [];
  const pageStatus = new Map(crawled.map((page) => [norm(page.url), page.statusCode]));

  // The funnel has one definition of "brand query"; the audit must not invent a
  // second one that disagrees with the detector that already filtered.
  const brandTerms = brandTermsFromDomain(site.domain);
  const audit: BoardAudit = {
    site: site.domain,
    live: opportunities.length,
    namesTarget: 0,
    newAsset: 0,
    targetAbsentFromCrawl: 0,
    targetNon200: 0,
    anchorsQuery: 0,
    queryInKey: 0,
    opaqueKey: 0,
    noQueryAnywhere: 0,
    demandMeasured: 0,
    demandUnmeasured: 0,
    clustered: 0,
    brandOnly: 0,
    hasOutcome: 0,
    winnabilityMeasured: 0,
    winnabilityAssumed: 0,
    winnabilityByInput: {},
    violations: [],
  };

  for (const opportunity of opportunities) {
    const decision = (opportunity.recommendationDecision ?? {}) as {
      target?: { url?: string; newAsset?: boolean } | null;
      expectedOutcome?: string | null;
    };
    const evidenceRefs = (opportunity.recommendationDecision as { evidenceRefs?: unknown } | null)?.evidenceRefs;
    const citedQuery = (Array.isArray(evidenceRefs) ? evidenceRefs : [])
      .map((ref) => (typeof ref === "string" ? queryByEvidenceId.get(ref) : undefined))
      .find((value) => value != null) ?? null;
    const target = decision.target?.url;
    if (typeof target === "string" && target.trim() !== "") {
      audit.namesTarget += 1;
      const status = pageStatus.get(norm(target));
      if (status === undefined) audit.targetAbsentFromCrawl += 1;
      else if (status !== 200) audit.targetNon200 += 1;
    } else if (decision.target?.newAsset) {
      // A page to create has no URL yet, and that is legitimate work.
      audit.newAsset += 1;
    }

    // A query in the dedup key is the cheap case; the acceptance criterion also
    // allows it to be carried by the evidence the row cites. A key that is an
    // opaque hash is not a check, so both are counted and reported separately.
    const keyQuery = queryFromKey(opportunity.dedupKey);
    const query = keyQuery ?? citedQuery;
    if (keyQuery) audit.queryInKey += 1;
    else audit.opaqueKey += 1;
    if (!query) {
      audit.noQueryAnywhere += 1;
    } else {
      audit.anchorsQuery += 1;
      if (isBrandQuery(query, brandTerms)) {
        audit.brandOnly += 1;
        audit.violations.push(`brand-only query "${query}" proposed as work`);
      }
    }

    // CMP-012: count what was actually measured for this row's winnability.
    const winnability = (opportunity.scoreInputs as {
      winProbability?: Partial<Record<string, number | null>>;
      winProbabilitySource?: Partial<Record<string, string>>;
    } | null) ?? null;
    const measurable = ["rankDistance", "authorityGap", "pageStrength", "serpCompetition"];
    // `measured` comes from the declared source, never from "the value is not null". A
    // legacy row holds the literal 0.5, so counting non-null values reported 142 of 144 as
    // measured and would have declared the defect fixed while every row still carried the
    // constant.
    const measuredInputs = measurable.filter((key) => winnability?.winProbabilitySource?.[key] === "measured");
    if (measuredInputs.length > 0) audit.winnabilityMeasured += 1;
    else audit.winnabilityAssumed += 1;
    for (const key of measuredInputs) {
      audit.winnabilityByInput[key] = (audit.winnabilityByInput[key] ?? 0) + 1;
    }

    const assessment = (opportunity.scoreInputs as { assessment?: { kind?: string } } | null)?.assessment;
    if (assessment?.kind === "measured" || assessment?.kind === "estimated") audit.demandMeasured += 1;
    else audit.demandUnmeasured += 1;

    if (opportunity.clusterId) audit.clustered += 1;

    if (typeof decision.expectedOutcome === "string" && decision.expectedOutcome.trim() !== "") audit.hasOutcome += 1;
  }

  if (audit.targetAbsentFromCrawl > 0) {
    audit.violations.push(`${audit.targetAbsentFromCrawl} target page(s) absent from the latest crawl`);
  }
  if (audit.targetNon200 > 0) {
    audit.violations.push(`${audit.targetNon200} target page(s) returned non-200 in the latest crawl`);
  }
  return audit;
}

async function main() {
  const argv = process.argv.slice(2);
  const siteId = argv.includes("--site") ? argv[argv.indexOf("--site") + 1] : null;
  const all = argv.includes("--all");
  if (!siteId && !all) throw new Error("--site <siteId> or --all is required");

  const db = new PrismaClient();
  const sites = await db.site.findMany({
    where: siteId ? { id: siteId } : { projectId: { not: null } },
    select: { id: true },
    orderBy: { domain: "asc" },
  });

  const audits: BoardAudit[] = [];
  for (const site of sites) audits.push(await auditSite(db, site.id));
  await db.$disconnect();

  const live = audits.filter((entry) => entry.live > 0);
  process.stdout.write(
    `${"site".padEnd(26)}${"live".padStart(5)}${"page".padStart(6)}${"new".padStart(5)}${"gone".padStart(6)}${"non200".padStart(7)}${"query".padStart(6)}${"hash".padStart(6)}${"noQ".padStart(5)}${"meas".padStart(6)}${"hypo".padStart(6)}${"topic".padStart(6)}${"brand".padStart(6)}${"win".padStart(5)}${"asm".padStart(5)}\n`
  );
  for (const entry of live) {
    process.stdout.write(
      `${entry.site.padEnd(26)}${String(entry.live).padStart(5)}${String(entry.namesTarget).padStart(6)}${String(entry.newAsset).padStart(5)}${String(entry.targetAbsentFromCrawl).padStart(6)}${String(entry.targetNon200).padStart(7)}${String(entry.anchorsQuery).padStart(6)}${String(entry.opaqueKey).padStart(6)}${String(entry.noQueryAnywhere).padStart(5)}${String(entry.demandMeasured).padStart(6)}${String(entry.demandUnmeasured).padStart(6)}${String(entry.clustered).padStart(6)}${String(entry.brandOnly).padStart(6)}${String(entry.winnabilityMeasured).padStart(5)}${String(entry.winnabilityAssumed).padStart(5)}\n`
    );
  }

  const total = live.reduce(
    (sum, entry) => ({
      live: sum.live + entry.live,
      namesTarget: sum.namesTarget + entry.namesTarget,
      newAsset: sum.newAsset + entry.newAsset,
      targetAbsentFromCrawl: sum.targetAbsentFromCrawl + entry.targetAbsentFromCrawl,
      targetNon200: sum.targetNon200 + entry.targetNon200,
      anchorsQuery: sum.anchorsQuery + entry.anchorsQuery,
      queryInKey: sum.queryInKey + entry.queryInKey,
      opaqueKey: sum.opaqueKey + entry.opaqueKey,
      noQueryAnywhere: sum.noQueryAnywhere + entry.noQueryAnywhere,
      demandMeasured: sum.demandMeasured + entry.demandMeasured,
      demandUnmeasured: sum.demandUnmeasured + entry.demandUnmeasured,
      clustered: sum.clustered + entry.clustered,
      brandOnly: sum.brandOnly + entry.brandOnly,
      hasOutcome: sum.hasOutcome + entry.hasOutcome,
      winnabilityMeasured: sum.winnabilityMeasured + entry.winnabilityMeasured,
      winnabilityAssumed: sum.winnabilityAssumed + entry.winnabilityAssumed,
    }),
    { live: 0, namesTarget: 0, newAsset: 0, targetAbsentFromCrawl: 0, targetNon200: 0, anchorsQuery: 0, queryInKey: 0, opaqueKey: 0, noQueryAnywhere: 0, demandMeasured: 0, demandUnmeasured: 0, clustered: 0, brandOnly: 0, hasOutcome: 0, winnabilityMeasured: 0, winnabilityAssumed: 0 }
  );
  process.stdout.write(
    `\n${total.live} live opportunities across ${live.length} sites ` +
      `(unmeasured impact: ${total.demandUnmeasured}; no page named: ${total.live - total.namesTarget - total.newAsset}; ` +
      `query in key: ${total.queryInKey}; query only in cited evidence: ${total.anchorsQuery - total.queryInKey}; ` +
      `no query anywhere: ${total.noQueryAnywhere}; unclustered: ${total.live - total.clustered})\n` +
      `winnability CMP-012: ${total.winnabilityMeasured} live row(s) with at least one measured input, ` +
      `${total.winnabilityAssumed} with none\n` +
      `  measured by input: ${Object.entries(
        audits.reduce<Record<string, number>>((acc, entry) => {
          for (const [key, count] of Object.entries(entry.winnabilityByInput)) acc[key] = (acc[key] ?? 0) + count;
          return acc;
        }, {})
      )
        .map(([key, count]) => `${key}=${count}`)
        .join(" ") || "none"}\n`
  );

  const violations = live.flatMap((entry) => entry.violations.map((violation) => `${entry.site}: ${violation}`));
  if (violations.length > 0) {
    process.stdout.write(`\nviolations:\n${violations.map((violation) => `  - ${violation}`).join("\n")}\n`);
  }
  // Read-only: it reports, it never repairs. Exit non-zero so CI can refuse.
  process.exitCode = violations.length > 0 ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${String((error as Error).message).slice(0, 400)}\n`);
  process.exitCode = 1;
});
