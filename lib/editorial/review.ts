import { createHash } from "node:crypto";
import type { ContentAction } from "@/lib/ai-seo/action-plan";
import { contentWriterConfig } from "@/lib/ai-seo/writer";

export type EditorialDecisionValue =
  | "update_page"
  | "add_section"
  | "new_article"
  | "metadata_only"
  | "dismiss";

export type PageFit = "strong" | "partial" | "none";

export type EditorialReview = {
  decision: EditorialDecisionValue;
  pageFit: PageFit;
  title: string;
  scope: string;
  rationale: string;
  confidence: number;
  mustPreserve: string[];
  fingerprint: string;
  model?: string;
  provider?: string;
};

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in",
  "is", "it", "me", "near", "nearby", "of", "on", "or", "the", "to", "what",
  "when", "where", "which", "who", "why", "with", "you", "your",
]);

const DECISIONS = new Set<EditorialDecisionValue>([
  "update_page",
  "add_section",
  "new_article",
  "metadata_only",
  "dismiss",
]);
const PAGE_FITS = new Set<PageFit>(["strong", "partial", "none"]);

function tokens(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9à-ÿ\s-]/gi, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .map((token) => token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  )];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampInt(value: unknown, fallback = 60): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : fallback;
}

export function editorialFingerprint(action: ContentAction): string {
  return createHash("sha256")
    .update([
      action.id,
      action.primaryQuery,
      action.targetUrl ?? "",
      action.signals.join(","),
      String(action.expectedClicks),
      action.page?.title ?? "",
    ].join(":"), "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function deterministicEditorialReview(action: ContentAction): EditorialReview {
  const fingerprint = editorialFingerprint(action);
  const queryTokens = tokens(action.primaryQuery || action.title);
  const pageText = [action.page?.title, action.page?.description].filter(Boolean).join(" ");
  const pageTokens = new Set(tokens(pageText));
  const overlap = queryTokens.filter((token) => pageTokens.has(token)).length;
  const localIntent = /\b(near me|nearby|in [a-z][a-z .'-]+|local|directions|open now)\b/i.test(action.primaryQuery);
  const pageFit: PageFit = !action.page || queryTokens.length === 0 || overlap === 0
    ? "none"
    : overlap >= 2 || queryTokens.length === 1
      ? "strong"
      : "partial";
  const pageTitle = action.page?.title || action.targetUrl || "the page";

  if (!action.targetUrl || pageFit === "none") {
    const dismiss = action.expectedClicks < 5;
    return {
      decision: dismiss ? "dismiss" : "new_article",
      pageFit,
      title: dismiss
        ? `Dismiss “${action.primaryQuery}”`
        : `Create an article for “${action.primaryQuery}”`,
      scope: dismiss
        ? "No clear page fit and not enough measured upside to justify new content."
        : `Create a new article that answers “${action.primaryQuery}” for this audience. Do not attach it to an existing page.`,
      rationale: dismiss
        ? "The query does not match the mapped page and the expected click upside is too small."
        : "The query has demand but no mapped page covers its intent well enough for an update.",
      confidence: 62,
      mustPreserve: [],
      fingerprint,
    };
  }

  if (localIntent) {
    return {
      decision: "add_section",
      pageFit,
      title: `Add a nearby-care section to “${pageTitle}”`,
      scope: `Add a focused section to “${pageTitle}” that answers the reader's local “${action.primaryQuery}” intent naturally. Keep the rest of the page intact. This is a section update, not a rewrite.`,
      rationale: "The page is relevant to the entity, but a local/nearby query is a narrower intent. A scoped section avoids forcing the query into the whole article.",
      confidence: 72,
      mustPreserve: ["existing page structure", "existing useful facts", "existing title and URL"],
      fingerprint,
    };
  }

  if (pageFit === "partial") {
    return {
      decision: "add_section",
      pageFit,
      title: `Add a focused section to “${pageTitle}”`,
      scope: `Add the missing intent for “${action.primaryQuery}” to “${pageTitle}” as a focused section. Preserve existing content and do not rewrite the page.`,
      rationale: "The query overlaps only partially with the page, so a full-page rewrite would overreach.",
      confidence: 68,
      mustPreserve: ["existing page structure", "existing useful facts"],
      fingerprint,
    };
  }

  return {
    decision: "update_page",
    pageFit,
    title: action.title,
    scope: action.recommendedAction,
    rationale: "The page and query have strong entity and intent overlap.",
    confidence: 82,
    mustPreserve: ["existing useful facts", "existing URL"],
    fingerprint,
  };
}

function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Editorial model returned unreadable JSON");
  }
}

function parseLlmReview(raw: unknown, fallback: EditorialReview, model: string, provider: string): EditorialReview {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const row = raw as Record<string, unknown>;
  const decision = text(row.decision) as EditorialDecisionValue;
  const pageFit = text(row.page_fit) as PageFit;
  const title = text(row.title);
  const scope = text(row.scope);
  const rationale = text(row.rationale);
  if (!DECISIONS.has(decision) || !PAGE_FITS.has(pageFit) || !title || !scope || rationale.length < 10) {
    return fallback;
  }
  const mustPreserve = Array.isArray(row.must_preserve)
    ? row.must_preserve.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8)
    : fallback.mustPreserve;
  return {
    decision,
    pageFit,
    title: title.slice(0, 200),
    scope: scope.slice(0, 2_000),
    rationale: rationale.slice(0, 2_000),
    confidence: clampInt(row.confidence, fallback.confidence),
    mustPreserve,
    fingerprint: fallback.fingerprint,
    model,
    provider,
  };
}

export async function reviewSeoOpportunity(action: ContentAction): Promise<EditorialReview> {
  const fallback = deterministicEditorialReview(action);
  const config = contentWriterConfig();
  if (!config || process.env.EDITORIAL_LLM_ENABLED === "false") return fallback;

  const payload = {
    site: action.targetUrl ? new URL(action.targetUrl).hostname : null,
    query: action.primaryQuery,
    candidate_title: action.title,
    candidate_kind: action.kind,
    candidate_format: action.format,
    target_url: action.targetUrl,
    page: action.page ? {
      url: action.page.url,
      title: action.page.title,
      description: action.page.description,
      word_count: action.page.wordCount,
      content_score: action.page.contentScore,
    } : null,
    evidence: action.evidence,
    signals: action.signals,
    intent: action.intent,
    expected_clicks: action.expectedClicks,
    confidence: action.confidence,
    deterministic_hint: fallback,
  };

  const prompt = [
    "You are the editorial reviewer for CrawlSEO.",
    "Decide whether this opportunity should update the mapped page, add a focused section, create a new article, change metadata only, or be dismissed.",
    "Only use the supplied query, page, metrics, signals, and existing candidate. Do not invent search data or page content.",
    "Prefer a focused section over a full-page rewrite when the query only partially matches the page.",
    "Never recommend forcing an exact keyword into an article. The scope should describe the reader intent and the specific change.",
    "Return exactly one JSON object.",
    "",
    JSON.stringify(payload, null, 2),
    "",
    "OUTPUT CONTRACT:",
    JSON.stringify({
      decision: "update_page|add_section|new_article|metadata_only|dismiss",
      page_fit: "strong|partial|none",
      title: "short action title",
      scope: "specific editorial brief for the writer",
      rationale: "why this action",
      confidence: 0,
      must_preserve: ["existing facts or sections to keep"],
    }, null, 2),
  ].join("\n");

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 1_500,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You make editorial decisions about SEO work. You do not write the article itself.",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return fallback;
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return fallback;
    return parseLlmReview(extractJson(content), fallback, config.model, config.baseUrl);
  } catch {
    return fallback;
  }
}
