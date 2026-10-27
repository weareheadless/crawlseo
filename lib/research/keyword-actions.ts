import { db } from "@/lib/db";
import { createResearchAction } from "@/lib/research/service";
import { keywordPriorityFor } from "@/lib/ai-seo/opportunity-priority";

export type KeywordActionInput = {
  keyword: string;
  volume?: number | null;
  difficulty?: number | null;
  cpc?: number | null;
  competition?: number | null;
  intent?: string | null;
};

export async function queueKeywordAction(
  siteId: string,
  input: KeywordActionInput,
  userId: string,
) {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });
  if (!site) throw new Error("Site not found");

  const keyword = input.keyword.trim();
  const evidence = {
    keyword_research: {
      keyword,
      volume: input.volume ?? null,
      difficulty: input.difficulty ?? null,
      cpc: input.cpc ?? null,
      competition: input.competition ?? null,
      intent: input.intent ?? null,
      queued_at: new Date().toISOString(),
    },
  };
  const priority = keywordPriorityFor(input.volume, input.difficulty);

  // Attach demand evidence to an existing open Action for the same query
  // instead of creating a second queue item for the same reader need.
  const existing = await db.researchAction.findFirst({
    where: {
      siteId,
      primaryQuery: keyword,
      status: { notIn: ["DISMISSED", "VERIFIED", "FULFILLED", "FAILED"] },
    },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    const currentEvidence = existing.evidence && typeof existing.evidence === "object" && !Array.isArray(existing.evidence)
      ? existing.evidence as Record<string, unknown>
      : {};
    const currentKeyword = currentEvidence.keyword_research && typeof currentEvidence.keyword_research === "object" && !Array.isArray(currentEvidence.keyword_research)
      ? currentEvidence.keyword_research as Record<string, unknown>
      : {};
    const action = await db.researchAction.update({
      where: { id: existing.id },
      data: {
        priority: Math.max(existing.priority, priority),
        evidence: {
          ...currentEvidence,
          keyword_research: { ...currentKeyword, ...evidence.keyword_research },
        },
      },
    });
    return { action, created: false, merged: true };
  }

  const result = await createResearchAction(
    siteId,
    {
      source: "keyword_research",
      kind: "create_article",
      format: "article",
      title: `Create content for “${keyword}”`,
      primaryQuery: keyword,
      recommendation: `Create an article grounded in the query intent and audience evidence. Demand: ${input.volume ?? "unknown"} searches/month; difficulty: ${input.difficulty ?? "unknown"}.`,
      evidence,
      priority,
      automationMode: "MANUAL",
    },
    userId,
  );
  return { ...result, merged: false };
}
