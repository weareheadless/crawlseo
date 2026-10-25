import { Prisma } from "@prisma/client";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { getContentActionPlan } from "@/lib/ai-seo/content-plan";
import { contentDraftView } from "@/lib/ai-seo/drafts";
import {
  briefForDraft,
  contentWriterConfigured,
  generateContentDraft,
  ContentWriterError,
} from "@/lib/ai-seo/writer";

const DRAFT_LIMIT_PER_HOUR = 12;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { siteId } = await params;
    const site = await db.site.findFirst({
      where: { id: siteId, userId },
      select: { userId: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const drafts = await db.contentDraft.findMany({
      where: { siteId, status: "READY" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return Response.json({
      writer_ready: contentWriterConfigured(),
      drafts: drafts.map(contentDraftView),
    });
  } catch (error) {
    console.error("Content drafts GET error:", error);
    return Response.json({ error: "Failed to load drafts" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { siteId } = await params;
    const site = await db.site.findFirst({
      where: { id: siteId, userId },
      select: { userId: true, domain: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (!contentWriterConfigured()) {
      return Response.json(
        {
          error: "Content writer is not configured",
          detail: "Set CONTENT_LLM_API_KEY (or OPENAI_API_KEY) and optionally CONTENT_LLM_BASE_URL / CONTENT_LLM_MODEL.",
        },
        { status: 503 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const input = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const opportunityKey = typeof input.opportunityKey === "string"
      ? input.opportunityKey.trim()
      : "";
    const instructions = typeof input.instructions === "string"
      ? input.instructions.trim().slice(0, 2_000)
      : "";
    if (!opportunityKey || opportunityKey.length > 120) {
      return Response.json({ error: "A valid opportunityKey is required" }, { status: 400 });
    }

    const recent = await db.contentDraft.count({
      where: {
        siteId,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });
    if (recent >= DRAFT_LIMIT_PER_HOUR) {
      return Response.json(
        { error: "Draft limit reached", detail: "Try again after the current one-hour window." },
        { status: 429 },
      );
    }

    const plan = await getContentActionPlan(siteId, site.domain);
    const action = plan.actions.find((item) => item.id === opportunityKey);
    if (!action) {
      return Response.json(
        { error: "Opportunity no longer exists", detail: "Refresh Content Studio and choose the action again." },
        { status: 404 },
      );
    }

    const generated = await generateContentDraft({
      domain: site.domain,
      action,
      instructions,
    });

    const draft = await db.contentDraft.create({
      data: {
        siteId,
        opportunityKey: action.id,
        actionKind: action.kind,
        format: action.format,
        primaryQuery: action.primaryQuery,
        targetUrl: action.targetUrl,
        intent: action.intent,
        title: generated.title,
        slug: generated.slug,
        metaTitle: generated.metaTitle,
        metaDescription: generated.metaDescription,
        excerpt: generated.excerpt,
        markdown: generated.markdown,
        outline: generated.outline as Prisma.InputJsonValue,
        brief: briefForDraft(action) as Prisma.InputJsonValue,
        model: generated.model,
        provider: generated.provider,
      },
    });

    return Response.json({ draft: contentDraftView(draft) }, { status: 201 });
  } catch (error) {
    if (error instanceof ContentWriterError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    console.error("Content drafts POST error:", error);
    return Response.json({ error: "Failed to generate draft" }, { status: 500 });
  }
}
