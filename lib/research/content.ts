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
import { selectEvidenceSources, sourceIdsForAction, sourcePublisher } from "@/lib/research/evidence";
import { isWixBlogTarget } from "@/lib/agent-tasks/targets";
import { configForSite, readWixBlogPostBySlug } from "@/lib/delivery/wix-blog";

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
  options: {
    requireApproval?: boolean;
    forceArticle?: boolean;
    currentBody?: string;
    currentTitle?: string;
    factSource?: string;
  } = {},
) {
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    include: {
      site: { select: { id: true, domain: true } },
      finding: { select: { evidenceSourceIds: true } },
      run: { select: { sources: { orderBy: { retrievedAt: "desc" }, take: 200 } } },
    },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);
  const requireApproval = options.requireApproval !== false;
  if (requireApproval && action.status !== "APPROVED" && action.status !== "DRAFTING") {
    throw new ResearchServiceError(
      "Approve the action before generating content",
      409,
    );
  }
  if (!requireApproval && !["PROPOSED", "APPROVED", "DRAFTING", "DRAFT_READY"].includes(action.status)) {
    throw new ResearchServiceError(
      `Cannot auto-draft an action in ${action.status} status`,
      409,
    );
  }

  const mapped = contentActionFromResearchAction(action);
  if (options.forceArticle) {
    mapped.format = "article";
    mapped.kind = "create_article";
  }
  if (options.currentBody) {
    mapped.evidence.current_body = options.currentBody.slice(0, 30_000);
  }
  if (options.currentTitle) {
    mapped.evidence.current_title = options.currentTitle;
  }
  const citedSources = selectEvidenceSources(
    action.run?.sources ?? [],
    sourceIdsForAction(action),
  ).slice(0, 12);
  const writerAction = citedSources.length === 0
    ? mapped
    : {
        ...mapped,
        evidence: {
          ...mapped.evidence,
          research_sources: citedSources.map((source) => ({
            title: source.title,
            url: source.url,
            provider: source.provider,
            publisher: sourcePublisher(source),
            published_at: source.publishedAt?.toISOString() ?? null,
            excerpt: source.excerpt?.slice(0, 1_500) ?? null,
          })),
        } as unknown as typeof mapped.evidence,
      };
  const generated = await generateContentDraft({
    domain: action.site.domain,
    action: writerAction,
    instructions,
  });

  const title = options.currentTitle?.trim() || generated.title;
  const withoutH1 = options.currentTitle
    ? generated.markdown.replace(/^#\s+.*\r?\n+/, "")
    : generated.markdown;
  const markdown = options.factSource
    ? stripUnsupportedNumericBlocks(withoutH1, options.factSource)
    : withoutH1;
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
      title,
      slug: generated.slug,
      metaTitle: generated.metaTitle,
      metaDescription: generated.metaDescription,
      excerpt: generated.excerpt,
      markdown,
      outline: generated.outline as Prisma.InputJsonValue,
      brief: briefForDraft(writerAction) as Prisma.InputJsonValue,
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


export async function generateWixBlogUpdateDraftForAction(
  actionId: string,
  instructions?: string,
) {
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    select: { id: true, siteId: true, targetUrl: true, status: true },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);
  if (!action.targetUrl || !isWixBlogTarget(action.targetUrl)) {
    throw new ResearchServiceError("This action is not a Wix Blog target", 409);
  }
  const slug = new URL(action.targetUrl).pathname.match(/\/post\/([^/?#]+)/i)?.[1];
  if (!slug) throw new ResearchServiceError("Could not read the Wix Blog slug from the target", 409);

  const cfg = await configForSite(action.siteId);
  if (!cfg) throw new ResearchServiceError("Wix Blog credentials are not configured for this site", 503);
  const existing = await readWixBlogPostBySlug(decodeURIComponent(slug), cfg);
  return generateDraftForAction(
    actionId,
    instructions || "Make a targeted update to the existing Wix Blog post. Preserve its title, URL, introduction, established facts, structure, and useful detail. Only add or strengthen what the action requires. Do not add cost comparisons, statistics, or new FAQs unless they are already in the current post or evidence.",
    {
      requireApproval: false,
      forceArticle: true,
      currentBody: existing.plainContent,
      currentTitle: existing.title,
      factSource: existing.plainContent,
    },
  );
}


function numericTokens(value: string): Set<string> {
  return new Set(
    (value.match(/\d[\d,.]*/g) ?? [])
      .map((token) => token.replace(/[.,]+$/, ""))
      .filter((token) => token.length > 1),
  );
}

/**
 * The editorial model sometimes imports plausible but unsupported numbers.
 * For existing blog posts, remove non-heading blocks whose figures cannot be
 * found in the current post. This keeps a full rewrite from publishing invented
 * statistics or cost comparisons.
 */
function stripUnsupportedNumericBlocks(markdown: string, source: string): string {
  const allowed = numericTokens(source);
  const blocks = markdown.split(/\n{2,}/);
  const kept: string[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }
    const unsupported = [...numericTokens(trimmed)].some((token) => !allowed.has(token));
    if (!unsupported) kept.push(trimmed);
  }
  return kept.join("\n\n");
}
