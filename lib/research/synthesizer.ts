import { contentWriterConfig } from "@/lib/ai-seo/writer";
import type { ResearchFindingType } from "@prisma/client";

export class ResearchSynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchSynthesisError";
  }
}

export type SynthesisSource = {
  provider: string;
  url: string;
  title: string | null;
  community: string | null;
  publishedAt: Date | null;
  excerpt: string | null;
};

export type SynthesizedFinding = {
  type: ResearchFindingType;
  theme: string;
  summary: string;
  confidence: number;
  sentiment?: string;
  urgency?: string;
  suggestedActionKind?: string;
  sourceIndexes: number[];
};

export type SynthesizedAction = {
  findingIndex: number;
  source: "market_research";
  kind: string;
  format?: "article" | "page_update" | "metadata";
  title: string;
  primaryQuery?: string;
  targetUrl?: string;
  recommendation: string;
  priority: number;
  automationMode: "MANUAL" | "ASSISTED" | "AUTOMATIC";
};

export type ResearchSynthesis = {
  findings: SynthesizedFinding[];
  actions: SynthesizedAction[];
  model: string;
  provider: string;
};

const FINDING_TYPES = new Set<ResearchFindingType>([
  "THEME",
  "QUESTION",
  "CONCERN",
  "OBJECTION",
  "TREND",
  "MISCONCEPTION",
  "CONTENT_GAP",
]);
const ACTION_FORMATS = new Set(["article", "page_update", "metadata"]);
const AUTOMATION_MODES = new Set(["MANUAL", "ASSISTED", "AUTOMATIC"]);

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clampInt(value: unknown, fallback = 50): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : fallback;
}

function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new ResearchSynthesisError("The research model returned unreadable JSON");
  }
}

export async function synthesizeResearch(input: {
  siteDomain: string;
  title: string;
  topics: string[];
  audience?: string | null;
  market?: string | null;
  questions: string[];
  sources: SynthesisSource[];
  candidatePages: string[];
}): Promise<ResearchSynthesis> {
  const config = contentWriterConfig();
  if (!config) {
    throw new ResearchSynthesisError(
      "Research synthesis is not configured. Set CONTENT_LLM_API_KEY (or OPENAI_API_KEY).",
    );
  }
  if (input.sources.length === 0) {
    throw new ResearchSynthesisError("No research sources were collected");
  }

  const sourcePayload = input.sources.slice(0, 30).map((source, index) => ({
    index,
    provider: source.provider,
    title: source.title,
    community: source.community,
    published_at: source.publishedAt?.toISOString() ?? null,
    url: source.url,
    excerpt: (source.excerpt ?? "").slice(0, 1_200),
  }));

  const prompt = [
    "You are the market research synthesizer for CrawlSEO.",
    "Use only the SOURCES below. Reddit and social posts are evidence of what people say, not proof of factual claims.",
    "Do not invent facts, statistics, prices, legal rules, medical advice, or business details.",
    "A finding must reference at least one source index. A single anecdote is not a market trend.",
    "Keep contradictory evidence visible instead of averaging it away.",
    "Propose content or page actions grounded in the evidence.",
    "Target URLs may only come from CANDIDATE PAGES. If no candidate page matches, target_url must be null.",
    "Return exactly one JSON object and no prose outside it.",
    "",
    `SITE: ${input.siteDomain}`,
    `RESEARCH TITLE: ${input.title}`,
    `TOPICS: ${JSON.stringify(input.topics)}`,
    `AUDIENCE: ${input.audience ?? "unknown"}`,
    `MARKET: ${input.market ?? "unknown"}`,
    `QUESTIONS: ${JSON.stringify(input.questions)}`,
    `CANDIDATE PAGES: ${JSON.stringify(input.candidatePages.slice(0, 30))}`,
    "",
    "SOURCES:",
    JSON.stringify(sourcePayload, null, 2),
    "",
    "OUTPUT CONTRACT:",
    JSON.stringify({
      findings: [{
        type: "THEME|QUESTION|CONCERN|OBJECTION|TREND|MISCONCEPTION|CONTENT_GAP",
        theme: "short label",
        summary: "evidence-grounded synthesis",
        confidence: 0,
        sentiment: "neutral|positive|negative|mixed",
        urgency: "low|medium|high",
        suggested_action_kind: "add_faq|create_article|update_page|add_section|rewrite_metadata",
        source_indexes: [0],
      }],
      actions: [{
        finding_index: 0,
        source: "market_research",
        kind: "add_faq|create_article|update_page|add_section|rewrite_metadata",
        format: "article|page_update|metadata",
        title: "action title",
        primary_query: "optional query",
        target_url: null,
        recommendation: "what to change and why",
        priority: 50,
        automation_mode: "MANUAL|ASSISTED|AUTOMATIC",
      }],
    }, null, 2),
  ].join("\n");

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
        temperature: 0.2,
        max_tokens: 6_000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You synthesize bounded public research into evidence-linked findings and content actions.",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new ResearchSynthesisError(
      error instanceof Error && /timeout|aborted/i.test(error.message)
        ? "The research model timed out"
        : "The research model could not be reached",
    );
  }
  if (!response.ok) {
    if (response.status === 429) {
      throw new ResearchSynthesisError("The research model is rate-limited (HTTP 429)");
    }
    throw new ResearchSynthesisError(`The research model returned HTTP ${response.status}`);
  }

  const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new ResearchSynthesisError("The research model returned an empty response");
  }
  const decoded = extractJson(content) as { findings?: unknown; actions?: unknown };
  if (!Array.isArray(decoded.findings) || !Array.isArray(decoded.actions)) {
    throw new ResearchSynthesisError("The research model returned an invalid report");
  }

  const findings: SynthesizedFinding[] = [];
  for (const raw of decoded.findings.slice(0, 12)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const type = text(row.type, 40).toUpperCase() as ResearchFindingType;
    const theme = text(row.theme, 240);
    const summary = text(row.summary, 4_000);
    const sourceIndexes = Array.isArray(row.source_indexes)
      ? row.source_indexes
        .filter((value): value is number => typeof value === "number" && Number.isInteger(value))
        .filter((value) => value >= 0 && value < sourcePayload.length)
      : [];
    if (!FINDING_TYPES.has(type) || !theme || summary.length < 20 || sourceIndexes.length === 0) continue;
    findings.push({
      type,
      theme,
      summary,
      confidence: clampInt(row.confidence),
      sentiment: text(row.sentiment, 40) || undefined,
      urgency: text(row.urgency, 40) || undefined,
      suggestedActionKind: text(row.suggested_action_kind, 80) || undefined,
      sourceIndexes: [...new Set(sourceIndexes)],
    });
  }
  if (findings.length === 0) {
    throw new ResearchSynthesisError("The research model returned no valid findings");
  }

  const candidatePages = new Set(input.candidatePages);
  const actions: SynthesizedAction[] = [];
  for (const raw of decoded.actions.slice(0, 12)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const findingIndex = typeof row.finding_index === "number" ? Math.floor(row.finding_index) : -1;
    if (findingIndex < 0 || findingIndex >= findings.length) continue;
    const title = text(row.title, 240);
    const recommendation = text(row.recommendation, 4_000);
    if (!title || recommendation.length < 10) continue;
    const format = text(row.format, 40);
    const automationMode = text(row.automation_mode, 40).toUpperCase();
    const targetUrl = text(row.target_url, 2_000);
    actions.push({
      findingIndex,
      source: "market_research",
      kind: text(row.kind, 80) || "update_page",
      format: ACTION_FORMATS.has(format) ? format as SynthesizedAction["format"] : undefined,
      title,
      primaryQuery: text(row.primary_query, 300) || undefined,
      targetUrl: targetUrl && candidatePages.has(targetUrl) ? targetUrl : undefined,
      recommendation,
      priority: clampInt(row.priority),
      automationMode: AUTOMATION_MODES.has(automationMode)
        ? automationMode as SynthesizedAction["automationMode"]
        : "MANUAL",
    });
  }

  return { findings, actions, model: config.model, provider: config.baseUrl };
}
