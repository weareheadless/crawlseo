import type { PrismaClient } from "@prisma/client";

import { knowledgeFactMeta, knowledgeFactValue } from "@/lib/projects/business-knowledge-facts";
import { resolveSiteContext, type ContextDb } from "@/lib/site/context";

/**
 * The business context one analysis run is allowed to reason from.
 *
 * This exists because the research synthesizer was given topics, goals, audience
 * and market but not the business facts, so a priced run could only produce
 * findings that fit any site in the market. Callers now hand the prompt one
 * object instead of assembling a subset each time.
 *
 * Only facts whose publication policy allows internal use are included; a fact
 * the owner prohibited is counted in `withheldFields`, never silently dropped.
 */

export type SiteBriefFact = {
  field: string;
  value: string;
  /** Provenance status: owner_confirmed, assumed, advised, … */
  status: string;
  /** Provenance kind: owner_input, ai_observation, research_observation, … */
  kind: string;
  sourceUrl: string | null;
};

export type SiteBrief = {
  siteId: string;
  projectId: string | null;
  domain: string;
  language: string;
  country: string | null;
  market: string | null;
  audienceMarket: string | null;
  audienceCountry: string | null;
  audience: string | null;
  topics: string[];
  goals: string[];
  facts: SiteBriefFact[];
  /** Fields present on the document but excluded by publication policy. */
  withheldFields: string[];
};

type BriefDb = ContextDb & Pick<PrismaClient, "researchPolicy" | "businessKnowledgeRevision">;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : [];
}

export async function buildSiteBrief(db: BriefDb, siteId: string): Promise<SiteBrief> {
  const context = await resolveSiteContext(db, siteId);
  const [profile, policy, document] = await Promise.all([
    db.siteProfile.findUnique({ where: { siteId }, select: { audience: true, topics: true } }),
    db.researchPolicy.findUnique({ where: { siteId }, select: { goals: true } }),
    context.projectId
      ? db.businessKnowledgeDocument.findUnique({
          where: { projectId: context.projectId },
          select: { revision: true, acceptedRevision: true, revisions: { orderBy: { revision: "desc" }, select: { revision: true, fields: true } } },
        })
      : Promise.resolve(null),
  ]);

  const facts: SiteBriefFact[] = [];
  const withheldFields: string[] = [];
  const revisionNumber = document ? (document.acceptedRevision ?? document.revision) : null;
  const revision = document && revisionNumber != null
    ? document.revisions.find((row) => row.revision === revisionNumber) ?? document.revisions[0]
    : null;
  if (revision?.fields && typeof revision.fields === "object" && !Array.isArray(revision.fields)) {
    for (const [field, value] of Object.entries(revision.fields as Record<string, unknown>)) {
      const values = knowledgeFactValue(value);
      if (values.length === 0) continue;
      const meta = knowledgeFactMeta(value);
      if (meta.publicationUse === "prohibited") {
        withheldFields.push(field);
        continue;
      }
      facts.push({
        field,
        value: values.join("; "),
        status: meta.provenanceStatus,
        kind: meta.provenanceKind,
        sourceUrl: meta.sourceUrl,
      });
    }
  }

  return {
    siteId: context.siteId,
    projectId: context.projectId,
    domain: context.domain,
    language: context.language,
    country: context.country,
    market: context.market,
    audienceMarket: context.audienceMarket,
    audienceCountry: context.audienceCountry,
    audience: typeof profile?.audience === "string" && profile.audience.trim() ? profile.audience : null,
    topics: strings(profile?.topics),
    goals: strings(policy?.goals),
    facts,
    withheldFields,
  };
}
