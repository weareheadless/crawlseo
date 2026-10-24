import type { ContentAction } from "@/lib/ai-seo/action-plan";

export type GeneratedContentDraft = {
  title: string;
  slug: string;
  metaTitle: string;
  metaDescription: string;
  excerpt: string;
  markdown: string;
  outline: string[];
  model: string;
  provider: string;
};

export type WriterConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export class ContentWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentWriterError";
  }
}

export function contentWriterConfig(): WriterConfig | null {
  const apiKey = (process.env.CONTENT_LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.CONTENT_LLM_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  const model = (process.env.CONTENT_LLM_MODEL || "gpt-4.1-mini").trim();
  if (!baseUrl || !model) return null;
  return { apiKey, baseUrl, model };
}

export function contentWriterConfigured(): boolean {
  return contentWriterConfig() !== null;
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new ContentWriterError("The content writer returned an unreadable draft");
  }
}

function outlineFromMarkdown(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^#{1,3}\s+/.test(line))
    .map((line) => line.replace(/^#{1,3}\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function validateGeneratedDraft(
  value: unknown,
  config: Pick<WriterConfig, "model">,
): GeneratedContentDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentWriterError("The content writer did not return a draft object");
  }
  const row = value as Record<string, unknown>;
  const title = text(row.title, 160);
  const markdown = typeof row.markdown === "string" ? row.markdown.trim().slice(0, 40_000) : "";
  const metaTitle = text(row.metaTitle ?? row.meta_title, 120);
  const metaDescription = text(row.metaDescription ?? row.meta_description, 240);
  const excerpt = text(row.excerpt, 400);
  const slug = slugify(text(row.slug, 120) || title);

  if (title.length < 8) throw new ContentWriterError("The generated draft title is missing or too short");
  if (!slug) throw new ContentWriterError("The generated draft slug is invalid");
  if (metaTitle.length < 10) throw new ContentWriterError("The generated draft is missing a meta title");
  if (metaDescription.length < 40) throw new ContentWriterError("The generated draft is missing a meta description");
  if (markdown.length < 180) throw new ContentWriterError("The generated draft body is too short");

  const outline = stringList(row.outline, 12);
  return {
    title,
    slug,
    metaTitle,
    metaDescription,
    excerpt: excerpt || `${markdown.replace(/^#+\s+/gm, "").replace(/\s+/g, " ").slice(0, 220)}…`,
    markdown,
    outline: outline.length > 0 ? outline : outlineFromMarkdown(markdown),
    model: config.model,
    provider: "openai-compatible",
  };
}

function formatInstruction(action: ContentAction): string {
  if (action.format === "metadata") {
    return [
      "Produce a metadata correction brief.",
      "In markdown, give the recommended title and meta description first, then two alternatives and a short rationale.",
      "Do not rewrite the whole page.",
    ].join(" ");
  }
  if (action.format === "page_update") {
    return [
      "Produce a page-update draft.",
      "In markdown, give a short diagnosis, the proposed revised sections in ready-to-paste Markdown, and internal-link suggestions.",
      "Only the page's metrics, title, and description are supplied; its body is not.",
      "Do not claim what the page currently contains, do not name entities from it, and do not present recommendations as existing content.",
    ].join(" ");
  }
  return [
    "Produce the requested article update in Markdown.",
    "If CURRENT BODY is supplied, use it as the source for existing facts and build on it rather than starting over.",
    "Use one H1, clear H2 sections, a concise introduction, and a direct answer near the top.",
    "Aim for 1,000-1,600 words. Do not add a sources section unless the evidence contains sources.",
    "Write for the reader. The editorial scope in EVIDENCE defines what to change.",
  ].join(" ");
}

function systemPrompt(): string {
  return [
    "You are a senior SEO editor inside CrawlSEO Content Studio.",
    "You write reviewable drafts for a human editor; you never publish and you never claim a change is live.",
    "The EVIDENCE block, including CURRENT BODY, is the only factual source. Treat it as closed-world and do not use prior knowledge.",
    "If a fact is not in the evidence, omit it or describe it as a recommendation.",
    "Write naturally. Do not force exact-match keywords, keyword-stuff, or add generic filler.",
    "Do not invent statistics, prices, dates, local facts, testimonials, credentials, guarantees, contact details, or third-party claims.",
    "Do not name a business, place, person, product, or service unless it appears in EVIDENCE.",
    "When the current page body is not supplied, do not claim what the page covers and do not list entities from it.",
    "Do not mention Search Console, CrawlSEO, prompts, models, or that the draft was AI-generated.",
    "Avoid generic filler, keyword stuffing, and absolute claims.",
    "Return exactly one JSON object and no prose outside it.",
  ].join(" ");
}

export async function generateContentDraft(input: {
  domain: string;
  action: ContentAction;
  instructions?: string;
}): Promise<GeneratedContentDraft> {
  const config = contentWriterConfig();
  if (!config) {
    throw new ContentWriterError(
      "Content writer is not configured. Set CONTENT_LLM_API_KEY (or OPENAI_API_KEY) and optionally CONTENT_LLM_BASE_URL / CONTENT_LLM_MODEL.",
    );
  }

  const currentBody = typeof input.action.evidence.current_body === "string"
    ? input.action.evidence.current_body.slice(0, 30_000)
    : null;
  const evidence = {
    site: input.domain,
    current_body: currentBody,
    action: {
      kind: input.action.kind,
      format: input.action.format,
      title: input.action.title,
      primary_query: input.action.primaryQuery,
      target_url: input.action.targetUrl,
      intent: input.action.intent,
      signals: input.action.signals,
      recommended_action: input.action.recommendedAction,
      expected_clicks: input.action.expectedClicks,
    },
    metrics: input.action.evidence,
    current_page: input.action.page,
  };

  const userPrompt = [
    `TASK\n${formatInstruction(input.action)}`,
    `EVIDENCE\n${JSON.stringify(evidence, null, 2)}`,
    input.instructions
      ? `EDITOR INSTRUCTIONS\n${input.instructions.slice(0, 2_000)}`
      : "EDITOR INSTRUCTIONS\nNone.",
    [
      "OUTPUT CONTRACT",
      JSON.stringify({
        title: "string",
        slug: "lowercase-kebab-case",
        metaTitle: "string",
        metaDescription: "string",
        excerpt: "string",
        markdown: "string",
        outline: ["string"],
      }, null, 2),
    ].join("\n"),
  ].join("\n\n");

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.4,
        max_tokens: 6_000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new ContentWriterError(
      error instanceof Error && /timeout|aborted/i.test(error.message)
        ? "The content writer timed out"
        : "The content writer could not be reached",
    );
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new ContentWriterError("The content writer is rate-limited (HTTP 429). Try again shortly.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new ContentWriterError(`The content writer rejected its credentials (HTTP ${response.status})`);
    }
    if (response.status >= 500) {
      throw new ContentWriterError(`The content writer is temporarily unavailable (HTTP ${response.status})`);
    }
    throw new ContentWriterError(`The content writer returned HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ContentWriterError("The content writer returned an unreadable response");
  }

  const choice = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
  const content = choice?.message?.content;
  const raw = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
          return "";
        })
        .join("")
      : "";
  if (!raw.trim()) {
    throw new ContentWriterError("The content writer returned an empty draft");
  }

  return validateGeneratedDraft(extractJson(raw), config);
}

export function briefForDraft(action: ContentAction): Record<string, unknown> {
  return {
    schema_version: 1,
    action_id: action.id,
    kind: action.kind,
    format: action.format,
    title: action.title,
    primary_query: action.primaryQuery,
    target_url: action.targetUrl,
    intent: action.intent,
    signals: action.signals,
    score: action.score,
    impact: action.impact,
    confidence: action.confidence,
    effort: action.effort,
    expected_clicks: action.expectedClicks,
    recommended_action: action.recommendedAction,
    evidence: action.evidence,
    current_page: action.page,
  };
}
