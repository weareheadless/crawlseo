import { createHash } from "node:crypto";
import type { ContentAction } from "@/lib/ai-seo/action-plan";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import {
  classifyEditorialTarget,
  type EditorialTargetClass,
} from "@/lib/editorial/targets";

export type EditorialDecisionValue =
  | "update_page"
  | "add_section"
  | "new_article"
  | "metadata_only"
  | "dismiss";

export type PageFit = "strong" | "partial" | "none";

export type EditorialCandidatePage = {
  url: string;
  title: string;
};

export type EditorialReview = {
  decision: EditorialDecisionValue;
  pageFit: PageFit;
  title: string;
  scope: string;
  rationale: string;
  confidence: number;
  mustPreserve: string[];
  fingerprint: string;
  targetUrl: string | null;
  originalTargetUrl: string | null;
  targetClass: EditorialTargetClass;
  model?: string;
  provider?: string;
};

const RULES_VERSION = "editorial-target-class-v3";

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

function normalizeWord(token: string): string {
  const normalized = token
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return normalized.length > 4 && normalized.endsWith("s") ? normalized.slice(0, -1) : normalized;
}

function tokens(value: string): string[] {
  return [...new Set(
    value
      .replace(/[^a-zA-Z0-9à-ÿ\s-]/gi, " ")
      .split(/\s+/)
      .map(normalizeWord)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  )];
}

function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5) {
    return a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5));
  }
  return false;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampInt(value: unknown, fallback = 60): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : fallback;
}

export function editorialFingerprint(
  action: ContentAction,
  landingPages: EditorialCandidatePage[] = [],
): string {
  return createHash("sha256")
    .update([
      RULES_VERSION,
      action.id,
      action.primaryQuery,
      action.targetUrl ?? "",
      action.signals.join(","),
      String(action.expectedClicks),
      action.page?.title ?? "",
      landingPages.map((page) => page.url).join(","),
    ].join(":"), "utf8")
    .digest("hex")
    .slice(0, 32);
}

function chooseLandingPage(
  action: ContentAction,
  landingPages: EditorialCandidatePage[],
): EditorialCandidatePage | null {
  if (landingPages.length === 0) return null;
  const queryTokens = tokens(`${action.primaryQuery} ${action.title}`);
  if (queryTokens.length === 0) return null;

  const preferredLocale = (url: string) => {
    try {
      return !/^\/(?:en|fr|es|de|it|pt)(?:\/|$)/i.test(new URL(url).pathname);
    } catch {
      return true;
    }
  };
  let best: { page: EditorialCandidatePage; score: number } | null = null;
  for (const page of landingPages) {
    const pageTokens = tokens(`${page.url} ${page.title}`);
    const score = queryTokens.reduce((total, queryToken) =>
      total + (pageTokens.some((pageToken) => tokenMatches(queryToken, pageToken)) ? 1 : 0), 0);
    if (score === 0) continue;
    if (!best
      || score > best.score
      || (score === best.score && preferredLocale(page.url) && !preferredLocale(best.page.url))
      || (score === best.score && preferredLocale(page.url) === preferredLocale(best.page.url)
          && page.url.length < best.page.url.length)) {
      best = { page, score };
    }
  }
  return best?.page ?? null;
}

function baseReview(
  action: ContentAction,
  fingerprint: string,
  input: {
    decision: EditorialDecisionValue;
    pageFit: PageFit;
    title: string;
    scope: string;
    rationale: string;
    confidence: number;
    mustPreserve: string[];
    targetUrl: string | null;
  },
): EditorialReview {
  const originalTarget = action.targetUrl;
  const targetClass = classifyEditorialTarget(input.targetUrl).targetClass;
  return {
    ...input,
    fingerprint,
    targetUrl: input.targetUrl,
    originalTargetUrl: originalTarget,
    targetClass,
  };
}

export function deterministicEditorialReview(
  action: ContentAction,
  options: { landingPages?: EditorialCandidatePage[] } = {},
): EditorialReview {
  const landingPages = options.landingPages ?? [];
  const fingerprint = editorialFingerprint(action, landingPages);
  const targetInfo = classifyEditorialTarget(action.targetUrl);
  const candidate = !targetInfo.durable ? chooseLandingPage(action, landingPages) : null;

  if (!targetInfo.durable) {
    if (candidate) {
      return baseReview(action, fingerprint, {
        decision: "add_section",
        pageFit: "partial",
        title: `Add a focused section to “${candidate.title || candidate.url}”`,
        scope: `Add the “${action.primaryQuery}” intent to the durable landing page “${candidate.title || candidate.url}” as a focused section. Do not edit the original product or listing page. Keep the rest of the landing page intact.`,
        rationale: `The original target is a ${targetInfo.targetClass} page (${targetInfo.reason}), which is too volatile for editorial content. A related category or landing page is the durable target.`,
        confidence: 78,
        mustPreserve: ["existing landing-page structure", "existing product/listing pages unchanged"],
        targetUrl: candidate.url,
      });
    }

    const dismiss = action.expectedClicks < 5;
    return baseReview(action, fingerprint, {
      decision: dismiss ? "dismiss" : "new_article",
      pageFit: "none",
      title: dismiss
        ? `Dismiss “${action.primaryQuery}”`
        : `Create an article for “${action.primaryQuery}”`,
      scope: dismiss
        ? `No durable landing page or meaningful upside justifies this ${targetInfo.targetClass} update.`
        : `Create a durable article or landing page for “${action.primaryQuery}”. Do not update the original ${targetInfo.targetClass} page.`,
      rationale: `The original target is a ${targetInfo.targetClass} page (${targetInfo.reason}) and no suitable durable landing page was found.`,
      confidence: 66,
      mustPreserve: [],
      targetUrl: null,
    });
  }

  const queryTokens = tokens(action.primaryQuery || action.title);
  const pageText = [action.page?.title, action.page?.description].filter(Boolean).join(" ");
  const pageTokens = tokens(pageText);
  const overlap = queryTokens.reduce((total, queryToken) =>
    total + (pageTokens.some((pageToken) => tokenMatches(queryToken, pageToken)) ? 1 : 0), 0);
  const localIntent = /\b(near me|nearby|in [a-z][a-z .'-]+|local|directions|open now)\b/i.test(action.primaryQuery);
  const pageFit: PageFit = !action.page || queryTokens.length === 0 || overlap === 0
    ? "none"
    : overlap >= 2 || queryTokens.length === 1
      ? "strong"
      : "partial";
  const pageTitle = action.page?.title || action.targetUrl || "the page";

  if (pageFit === "none") {
    return baseReview(action, fingerprint, {
      decision: action.expectedClicks < 5 ? "dismiss" : "new_article",
      pageFit,
      title: action.expectedClicks < 5
        ? `Dismiss “${action.primaryQuery}”`
        : `Create an article for “${action.primaryQuery}”`,
      scope: action.expectedClicks < 5
        ? "No clear page fit and not enough measured upside to justify new content."
        : `Create a new durable article that answers “${action.primaryQuery}”.`,
      rationale: "The query does not match the durable target page well enough for an update.",
      confidence: 62,
      mustPreserve: [],
      targetUrl: null,
    });
  }

  if (localIntent) {
    return baseReview(action, fingerprint, {
      decision: "add_section",
      pageFit,
      title: `Add a nearby-care section to “${pageTitle}”`,
      scope: `Add a focused section to “${pageTitle}” that answers the reader's local “${action.primaryQuery}” intent naturally. Keep the rest of the page intact. This is a section update, not a rewrite.`,
      rationale: "The page is relevant to the entity, but a local/nearby query is a narrower intent. A scoped section avoids forcing the query into the whole article.",
      confidence: 72,
      mustPreserve: ["existing page structure", "existing useful facts", "existing title and URL"],
      targetUrl: action.targetUrl,
    });
  }

  if (pageFit === "partial") {
    return baseReview(action, fingerprint, {
      decision: "add_section",
      pageFit,
      title: `Add a focused section to “${pageTitle}”`,
      scope: `Add the missing intent for “${action.primaryQuery}” to “${pageTitle}” as a focused section. Preserve existing content and do not rewrite the page.`,
      rationale: "The query overlaps only partially with the page, so a full-page rewrite would overreach.",
      confidence: 68,
      mustPreserve: ["existing page structure", "existing useful facts"],
      targetUrl: action.targetUrl,
    });
  }

  return baseReview(action, fingerprint, {
    decision: "update_page",
    pageFit,
    title: action.title,
    scope: action.recommendedAction,
    rationale: "The page and query have strong entity and intent overlap.",
    confidence: 82,
    mustPreserve: ["existing useful facts", "existing URL"],
    targetUrl: action.targetUrl,
  });
}

function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Editorial model returned unreadable JSON");
  }
}

function parseLlmReview(
  raw: unknown,
  fallback: EditorialReview,
  model: string,
  provider: string,
  allowedTargets: Set<string>,
): EditorialReview {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const row = raw as Record<string, unknown>;
  const decision = text(row.decision) as EditorialDecisionValue;
  const pageFit = text(row.page_fit) as PageFit;
  const title = text(row.title);
  const scope = text(row.scope);
  const rationale = text(row.rationale);
  const requestedTarget = text(row.target_url);
  if (!DECISIONS.has(decision) || !PAGE_FITS.has(pageFit) || !title || !scope || rationale.length < 10) {
    return fallback;
  }
  if (decision !== "dismiss" && decision !== "new_article" && requestedTarget && !allowedTargets.has(requestedTarget)) {
    return fallback;
  }
  const targetUrl = requestedTarget && allowedTargets.has(requestedTarget)
    ? requestedTarget
    : fallback.targetUrl;
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
    targetUrl: decision === "new_article" || decision === "dismiss" ? null : targetUrl,
    originalTargetUrl: fallback.originalTargetUrl,
    targetClass: classifyEditorialTarget(targetUrl).targetClass,
    model,
    provider,
  };
}

export async function reviewSeoOpportunity(
  action: ContentAction,
  options: { landingPages?: EditorialCandidatePage[] } = {},
): Promise<EditorialReview> {
  const landingPages = options.landingPages ?? [];
  const fallback = deterministicEditorialReview(action, options);
  const config = contentWriterConfig();
  if (!config || process.env.EDITORIAL_LLM_ENABLED === "false") return fallback;

  const allowedTargets = new Set([
    ...(action.targetUrl ? [action.targetUrl] : []),
    ...landingPages.map((page) => page.url),
  ]);
  const payload = {
    site: action.targetUrl ? new URL(action.targetUrl).hostname : null,
    query: action.primaryQuery,
    candidate_title: action.title,
    candidate_kind: action.kind,
    candidate_format: action.format,
    target_url: action.targetUrl,
    target_class: fallback.targetClass,
    target_class_reason: classifyEditorialTarget(action.targetUrl).reason,
    candidate_landing_pages: landingPages.slice(0, 40),
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
    "Decide whether this opportunity should update a durable landing page, add a focused section, create a new article, change metadata only, or be dismissed.",
    "Product pages, individual listing pages, and system pages are not editorial targets. If the current target is one of those, choose a durable category or landing page from candidate_landing_pages, or create a new article.",
    "Only use the supplied query, page, metrics, signals, and candidates. Do not invent search data or page content.",
    "Prefer a focused section over a full-page rewrite when the query only partially matches the page.",
    "Never recommend forcing an exact keyword into an article. The scope should describe the reader intent and the specific change.",
    "target_url must be null or one of the supplied candidate target URLs.",
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
      target_url: "one of the supplied URLs or null",
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
    return parseLlmReview(extractJson(content), fallback, config.model, config.baseUrl, allowedTargets);
  } catch {
    return fallback;
  }
}
