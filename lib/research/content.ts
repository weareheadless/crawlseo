import { Prisma, type ResearchAction } from "@prisma/client";
import { db } from "@/lib/db";
import {
  classifySearchIntent,
  type ContentAction,
  type ContentActionFormat,
  type ContentActionKind,
  type OpportunitySignal,
  type PageEvidence,
} from "@/lib/ai-seo/action-plan";
import { briefForDraft, generateContentDraft } from "@/lib/ai-seo/writer";
import { ResearchServiceError } from "@/lib/research/service";

const SIGNALS = new Set<OpportunitySignal>([
  "striking_distance",
  "low_ctr",
  "content_decay",
  "cannibalization",
]);

function record(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mapKind(kind: string, format: string | null): ContentActionKind {
  if (kind === "create_article" || format === "article") return "create_article";
  if (kind === "rewrite_metadata" || kind === "improve_metadata" || format === "metadata") {
    return "improve_metadata";
  }
  if (kind === "refresh_decaying_page") return "refresh_decaying_page";
  if (kind === "consolidate_pages") return "consolidate_pages";
  return "improve_page";
}

function mapFormat(kind: ContentActionKind): ContentActionFormat {
  if (kind === "create_article") return "article";
  if (kind === "improve_metadata") return "metadata";
  return "page_update";
}

function effort(kind: ContentActionKind): number {
  if (kind === "improve_metadata") return 12;
  if (kind === "improve_page") return 38;
  if (kind === "refresh_decaying_page") return 46;
  if (kind === "create_article") return 68;
  return 78;
}

function pageEvidence(value: unknown): PageEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const page = value as Record<string, unknown>;
  if (typeof page.url !== "string") return null;
  return {
    url: page.url,
    title: typeof page.title === "string" ? page.title : "",
    description: typeof page.description === "string" ? page.description : "",
    wordCount: typeof page.wordCount === "number" ? page.wordCount : 0,
    contentScore: typeof page.contentScore === "number" ? page.contentScore : 0,
    h1Count: typeof page.h1Count === "number" ? page.h1Count : 0,
    statusCode: typeof page.statusCode === "number" ? page.statusCode : 200,
  };
}

export function contentActionFromResearchAction(action: ResearchAction): ContentAction {
  const evidence = record(action.evidence);
  const kind = mapKind(action.kind, action.format);
  const format = mapFormat(kind);
  const signals = Array.isArray(evidence.signals)
    ? evidence.signals.filter((signal): signal is OpportunitySignal =>
        typeof signal === "string" && SIGNALS.has(signal as OpportunitySignal))
    : [];
  const query = action.primaryQuery ?? "";
  const confidence = typeof evidence.confidence === "number"
    ? evidence.confidence <= 1 ? evidence.confidence * 100 : evidence.confidence
    : 60;
  const expectedClicks = typeof evidence.expected_clicks === "number"
    ? evidence.expected_clicks
    : 0;

  return {
    id: action.id,
    kind,
    format,
    title: action.title,
    primaryQuery: query,
    targetUrl: action.targetUrl,
    intent: classifySearchIntent(query || action.title),
    signals,
    evidence: {
      ...evidence,
      research_action_source: action.source,
      research_action_priority: action.priority,
    },
    page: pageEvidence(evidence.page),
    impact: action.priority,
    confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    effort: effort(kind),
    score: action.priority,
    expectedClicks,
    recommendedAction: action.recommendation,
  };
}

export async function generateDraftForAction(
  actionId: string,
  instructions?: string,
) {
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    include: { site: { select: { id: true, domain: true } } },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);
  if (action.status !== "APPROVED" && action.status !== "DRAFTING") {
    throw new ResearchServiceError(
      "Approve the action before generating content",
      409,
    );
  }

  const mapped = contentActionFromResearchAction(action);
  const generated = await generateContentDraft({
    domain: action.site.domain,
    action: mapped,
    instructions,
  });

  const draft = await db.contentDraft.create({
    data: {
      siteId: action.siteId,
      actionId: action.id,
      opportunityKey: action.dedupeKey,
      actionKind: action.kind,
      format: mapped.format,
      primaryQuery: action.primaryQuery ?? "",
      targetUrl: action.targetUrl,
      intent: mapped.intent,
      title: generated.title,
      slug: generated.slug,
      metaTitle: generated.metaTitle,
      metaDescription: generated.metaDescription,
      excerpt: generated.excerpt,
      markdown: generated.markdown,
      outline: generated.outline as Prisma.InputJsonValue,
      brief: briefForDraft(mapped) as Prisma.InputJsonValue,
      model: generated.model,
      provider: generated.provider,
    },
  });

  await db.researchAction.update({
    where: { id: action.id },
    data: { status: "DRAFT_READY" },
  });

  return draft;
}
