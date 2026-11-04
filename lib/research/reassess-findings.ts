import type { PrismaClient } from "@prisma/client";

import { assessCoverage, type CoveragePage } from "@/lib/research/page-coverage";
import { buildPageInventory } from "@/lib/research/page-inventory";
import { verifySiteClaim, type PageTypeInventory, type SiteClaim } from "@/lib/research/site-claims";
import { supersedeEvidenceRecord, type EvidenceDb } from "@/lib/funnel/evidence";

/**
 * Reassessment of findings stored before the claim contract (brief §6).
 *
 * Findings bridged before the contract carry no verification, so a contradicted
 * premise sits on the board at a low score. Waiting for the next research run would
 * leave a known-false recommendation visible for a month, so this pass re-verifies
 * what is already stored, using the same rules as new findings.
 *
 * It is tenant-agnostic: the only inputs are the site's own inventory, its stored
 * page text and the finding text. Nothing here names a domain.
 */

const ABSENCE_MARKER = /\b(no|not|never|none|lacks?|lacking|missing|without|absent|aucun|aucune|pas de|sans|nunca|sin|ning[uú]n|keine)\b/i;
const UNUSABLE_MARKER = /hors sujet|irrelevant|off[- ]topic|aucune source|no source|no evidence|absence de preuve|no market conclusion|sources? (?:are|were) not|not about the research/i;

export type DerivedClaim = {
  claim: SiteClaim | null;
  sourcesUnusable: boolean;
};

/**
 * Derive the claim a legacy finding is making.
 *
 * Only two things are asserted mechanically, and both are conservative because a
 * wrong derivation here removes work:
 *  - a page type that exists in the inventory and is named in an absence sentence
 *    means the finding claims that type is missing;
 *  - a finding that says its own sources are irrelevant is a pipeline failure.
 *
 * Everything else stays unverified rather than being guessed.
 */
export function deriveClaimFromFinding(
  text: string,
  inventory: PageTypeInventory[]
): DerivedClaim {
  const sourcesUnusable = UNUSABLE_MARKER.test(text);
  if (!ABSENCE_MARKER.test(text)) return { claim: null, sourcesUnusable };

  // Deliberately narrow. A finding must say "no <type>" (at most one word between)
  // and the type must be lower-case, so "no Mexico City inventory" is not read as
  // "no city pages". Anything looser turns a competitor quote or a parenthetical URL
  // list into a claim about the site, and a wrong derivation here removes real work.
  for (const entry of inventory) {
    if (entry.pages < 3) continue;
    const base = entry.type.replace(/ies$/i, "y").replace(/ses$/i, "s").replace(/s$/i, "").toLowerCase();
    if (base.length < 3) continue;
    const type = base.replace(/[^a-z0-9-]/g, "");
    const proximity = new RegExp(
      `\\b(no|not|never|without|none|lacks?|missing|aucun|aucune|pas de|sans)\\s+(?:[a-zà-ÿ'-]+\\s+){0,2}${type}(?:s|es)?\\b`
    );
    if (!proximity.test(text)) continue;
    return {
      claim: { kind: "missing_page_type", pageType: entry.type, statement: text.slice(0, 300) },
      sourcesUnusable,
    };
  }
  return {
    claim: { kind: "absent_offering", pageType: null, statement: text.slice(0, 300) },
    sourcesUnusable,
  };
}

export type ReassessDb = EvidenceDb & Pick<PrismaClient, "crawl" | "auditPage" | "researchFinding" | "evidenceRecord">;

export type ReassessResult = {
  findings: number;
  updated: number;
  contradicted: number;
  rejectedQuality: number;
  coverageComplete: boolean;
  pagesWithText: number;
  /** What each re-verified finding would become. */
  outcomes: Array<{ theme: string; status: string; reason: string }>;
};

/**
 * Re-verify active research findings that have no verification yet.
 *
 * Evidence is immutable: a changed verification is written as a new record that
 * supersedes the old one, so the history of what was believed stays visible.
 */
export async function reassessLegacyFindings(
  db: ReassessDb,
  input: { projectId: string; siteId: string; dryRun?: boolean }
): Promise<ReassessResult> {
  const result: ReassessResult = {
    findings: 0,
    updated: 0,
    contradicted: 0,
    rejectedQuality: 0,
    coverageComplete: false,
    pagesWithText: 0,
    outcomes: [],
  };

  const crawl = await db.crawl.findFirst({
    where: { siteId: input.siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, pagesFound: true, maxPages: true },
  });
  if (!crawl) return result;

  const pages = await db.auditPage.findMany({
    where: { crawlId: crawl.id },
    select: { url: true, title: true, contentText: true, statusCode: true },
  });
  const coveragePages: CoveragePage[] = pages.map((page) => ({
    url: page.url,
    title: page.title,
    contentText: page.contentText ?? null,
    unavailableReason: page.statusCode !== 200 ? `HTTP ${page.statusCode}` : page.contentText ? null : "no text extracted",
  }));
  result.pagesWithText = coveragePages.filter((page) => page.contentText).length;

  const inventory = buildPageInventory(pages.map((page) => ({ url: page.url, contentScore: 0 })));
  const blocked = pages.filter((page) => page.statusCode !== 200).length;
  const capped = crawl.maxPages > 0 && crawl.pagesFound >= crawl.maxPages;
  result.coverageComplete = !capped && blocked === 0 && result.pagesWithText > 0;

  const findings = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, kind: "research_finding", supersededById: null },
    select: { id: true, dimensions: true, metrics: true, observedAt: true },
  });

  for (const finding of findings) {
    const dimensions = (finding.dimensions ?? {}) as Record<string, string | null>;
    if (dimensions.verification) continue;
    result.findings += 1;

    const text = [dimensions.theme, dimensions.painPointSummary, dimensions.gapSummary]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(". ");
    const derived = deriveClaimFromFinding(text, inventory.groups);
    const coverage = derived.claim
      ? assessCoverage({ statement: derived.claim.statement }, coveragePages)
      : assessCoverage({ statement: text.slice(0, 400) }, coveragePages);
    const verification = derived.claim
      ? verifySiteClaim(derived.claim, { inventory: inventory.groups, coverage, coverageComplete: result.coverageComplete })
      : {
          status: "unverified" as const,
          reason: derived.sourcesUnusable
            ? "the finding says its own sources were not about the research topic"
            : coverage.length === 0
              ? "no page content was assessed for this claim"
              : "the claim is not stated in a form that can be checked",
          coverage,
          coverageComplete: result.coverageComplete,
        };

    if (verification.status === "contradicted") result.contradicted += 1;
    if (derived.sourcesUnusable) result.rejectedQuality += 1;
    result.outcomes.push({
      theme: dimensions.theme ?? "(no theme)",
      status: verification.status,
      reason: verification.reason,
    });
    if (input.dryRun) continue;

    await supersedeEvidenceRecord(db, finding.id, {
      projectId: input.projectId,
      siteId: input.siteId,
      kind: "research_finding",
      observedAt: finding.observedAt,
      producer: "legacy-diagnostic",
      dimensions: {
        ...dimensions,
        verification: verification.status,
        verificationReason: verification.reason,
        coverageState: coverage[0]?.state ?? null,
        coveragePage: coverage[0]?.pageUrl ?? null,
        coverageComplete: result.coverageComplete ? "true" : "false",
      },
      metrics: (finding.metrics ?? {}) as never,
    });
    result.updated += 1;
  }

  return result;
}
