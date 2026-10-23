import { createHash } from "node:crypto";

export type ContentActionKind =
  | "improve_metadata"
  | "improve_page"
  | "create_article"
  | "refresh_decaying_page"
  | "consolidate_pages";

export type ContentActionFormat = "metadata" | "page_update" | "article";
export type SearchIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational"
  | "local";
export type OpportunitySignal =
  | "striking_distance"
  | "low_ctr"
  | "content_decay"
  | "cannibalization";

export type PageEvidence = {
  url: string;
  title: string;
  description: string;
  wordCount: number;
  contentScore: number;
  h1Count: number;
  statusCode: number;
};

export type KeywordEvidence = {
  query: string;
  position: number;
  clicks: number;
  impressions: number;
  ctr: number;
  potential?: number;
  expectedCtr?: number;
  ctrGap?: number;
};

export type DecayEvidence = {
  url: string;
  currentClicks: number;
  previousClicks: number;
  changePct: number;
};

export type CannibalEvidence = {
  query: string;
  pages: Array<{
    url: string;
    clicks: number;
    impressions: number;
    position: number;
  }>;
};

export type ContentAction = {
  id: string;
  kind: ContentActionKind;
  format: ContentActionFormat;
  title: string;
  primaryQuery: string;
  targetUrl: string | null;
  intent: SearchIntent;
  signals: OpportunitySignal[];
  evidence: Record<string, string | number | boolean | null>;
  page: PageEvidence | null;
  impact: number;
  confidence: number;
  effort: number;
  score: number;
  expectedClicks: number;
  recommendedAction: string;
};

export type ContentActionPlan = {
  generatedAt: string;
  summary: {
    total: number;
    highPriority: number;
    articles: number;
    pageUpdates: number;
    metadata: number;
    expectedClicks: number;
  };
  actions: ContentAction[];
};

export type BuildContentActionPlanInput = {
  siteId: string;
  domain: string;
  striking: KeywordEvidence[];
  lowCtr: KeywordEvidence[];
  decay: DecayEvidence[];
  cannibal: CannibalEvidence[];
  queryTargets?: Record<string, string>;
  pages?: Record<string, PageEvidence>;
  generatedAt?: string;
};

export function expectedCtrAtPosition(position: number): number {
  if (position <= 1) return 0.28;
  if (position <= 2) return 0.15;
  if (position <= 3) return 0.11;
  if (position <= 5) return 0.07;
  if (position <= 10) return 0.03;
  if (position <= 20) return 0.01;
  return 0.005;
}

export function classifySearchIntent(query: string): SearchIntent {
  const value = query.toLowerCase();
  if (/\b(login|sign in|official|website|portal|account)\b/.test(value)) {
    return "navigational";
  }
  if (/\b(near me|in [a-z][a-z .'-]+|local|directions|open now)\b/.test(value)) {
    return "local";
  }
  if (/\b(buy|price|pricing|cost|for sale|rent|book|hire|quote|discount|deal)\b/.test(value)) {
    return "transactional";
  }
  if (/\b(best|top|review|reviews|compare|comparison|vs|versus|alternative|choose)\b/.test(value)) {
    return "commercial";
  }
  if (/^(how|what|why|when|where|who|which|can|does|do|is|are)\b/.test(value)
    || /\b(guide|tips|ideas|checklist|examples|explained|learn|beginners?)\b/.test(value)) {
    return "informational";
  }
  return "commercial";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function impactFromClicks(expectedClicks: number): number {
  return clamp(Math.round(Math.log10(1 + Math.max(0, expectedClicks)) * 34), 5, 100);
}

function confidenceFromImpressions(impressions: number): number {
  if (impressions >= 500) return 88;
  if (impressions >= 100) return 74;
  if (impressions >= 20) return 58;
  return 40;
}

function actionId(siteId: string, key: string): string {
  return createHash("sha256")
    .update(`${siteId}:${key}`, "utf8")
    .digest("hex")
    .slice(0, 20);
}

function effortFor(kind: ContentActionKind): number {
  switch (kind) {
    case "improve_metadata":
      return 12;
    case "improve_page":
      return 38;
    case "refresh_decaying_page":
      return 46;
    case "create_article":
      return 68;
    case "consolidate_pages":
      return 78;
  }
}

function formatFor(kind: ContentActionKind): ContentActionFormat {
  if (kind === "improve_metadata") return "metadata";
  if (kind === "create_article") return "article";
  return "page_update";
}

function kindForSignals(signals: Set<OpportunitySignal>, hasTarget: boolean): ContentActionKind {
  if (signals.has("cannibalization")) return "consolidate_pages";
  if (signals.has("content_decay")) return "refresh_decaying_page";
  if (signals.has("striking_distance")) {
    return hasTarget ? "improve_page" : "create_article";
  }
  if (signals.has("low_ctr")) {
    return hasTarget ? "improve_metadata" : "create_article";
  }
  return hasTarget ? "improve_page" : "create_article";
}

function recommendedActionFor(kind: ContentActionKind): string {
  switch (kind) {
    case "improve_metadata":
      return "Rewrite the title and meta description around the query, then measure CTR for 28 days.";
    case "improve_page":
      return "Strengthen the existing page with the missing intent, clearer headings, and supporting internal links.";
    case "create_article":
      return "Write a new source-grounded article for the query and link it from the closest relevant page.";
    case "refresh_decaying_page":
      return "Refresh outdated sections, restore internal links, and re-check the page against current search intent.";
    case "consolidate_pages":
      return "Choose the strongest URL, merge unique value into it, and consolidate or redirect the competing pages.";
  }
}

function titleFor(kind: ContentActionKind, query: string, url: string | null): string {
  if (kind === "create_article") return `Create an article for “${query}”`;
  if (kind === "improve_metadata") return `Rewrite metadata for “${query}”`;
  if (kind === "consolidate_pages") return `Consolidate pages for “${query}”`;
  if (kind === "refresh_decaying_page") {
    try {
      const path = new URL(url || "").pathname;
      return `Refresh ${path || "the declining page"}`;
    } catch {
      return "Refresh the declining page";
    }
  }
  return `Strengthen the page for “${query}”`;
}

function mergeAction(existing: ContentAction, next: ContentAction): ContentAction {
  const signals = [...new Set([...existing.signals, ...next.signals])];
  const kind = kindForSignals(new Set(signals), Boolean(existing.targetUrl || next.targetUrl));
  const format = formatFor(kind);
  const targetUrl = existing.targetUrl || next.targetUrl;
  const primaryQuery = existing.primaryQuery || next.primaryQuery;
  const page = existing.page || next.page;
  const evidence = { ...existing.evidence, ...next.evidence };
  const confidence = Math.max(existing.confidence, next.confidence);
  const effort = effortFor(kind);
  const expectedClicks = Math.max(existing.expectedClicks, next.expectedClicks);
  const impact = impactFromClicks(expectedClicks);
  return {
    ...existing,
    kind,
    format,
    title: titleFor(kind, primaryQuery, targetUrl),
    targetUrl,
    signals,
    evidence,
    page,
    confidence,
    effort,
    expectedClicks,
    impact,
    score: round(impact * 0.55 + confidence * 0.25 + (100 - effort) * 0.2),
    recommendedAction: recommendedActionFor(kind),
  };
}

function buildFromKeyword(
  siteId: string,
  item: KeywordEvidence,
  signal: "striking_distance" | "low_ctr",
  targetUrl: string | null,
  page: PageEvidence | null,
): ContentAction {
  const intent = classifySearchIntent(item.query);
  const signals = new Set<OpportunitySignal>([signal]);
  const kind = kindForSignals(signals, Boolean(targetUrl));
  const expectedClicks = signal === "striking_distance"
    ? Math.max(0, (item.potential ?? item.impressions * expectedCtrAtPosition(Math.max(1, item.position - 3))) - item.clicks)
    : Math.max(0, item.impressions * (item.ctrGap ?? Math.max(0, expectedCtrAtPosition(item.position) - item.ctr)));
  const confidence = confidenceFromImpressions(item.impressions);
  const effort = effortFor(kind);
  const impact = impactFromClicks(expectedClicks);
  const evidence: Record<string, string | number | boolean | null> = {
    position: round(item.position, 1),
    clicks: item.clicks,
    impressions: item.impressions,
    ctr: round(item.ctr * 100, 2),
    expected_ctr: signal === "low_ctr" && item.expectedCtr != null
      ? round(item.expectedCtr * 100, 2)
      : null,
    ctr_gap: signal === "low_ctr" && item.ctrGap != null
      ? round(item.ctrGap * 100, 2)
      : null,
    page_title: page?.title || null,
    page_words: page?.wordCount ?? null,
    page_content_score: page?.contentScore ?? null,
  };
  return {
    id: actionId(siteId, `query:${item.query.toLowerCase()}`),
    kind,
    format: formatFor(kind),
    title: titleFor(kind, item.query, targetUrl),
    primaryQuery: item.query,
    targetUrl,
    intent,
    signals: [signal],
    evidence,
    page,
    impact,
    confidence,
    effort,
    score: round(impact * 0.55 + confidence * 0.25 + (100 - effort) * 0.2),
    expectedClicks: round(expectedClicks),
    recommendedAction: recommendedActionFor(kind),
  };
}

export function buildContentActionPlan(input: BuildContentActionPlanInput): ContentActionPlan {
  const pages = input.pages ?? {};
  const queryTargets = input.queryTargets ?? {};
  const byKey = new Map<string, ContentAction>();

  function add(key: string, action: ContentAction) {
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeAction(existing, action) : action);
  }

  for (const item of input.striking) {
    const targetUrl = queryTargets[item.query] || null;
    add(
      `query:${item.query.toLowerCase()}`,
      buildFromKeyword(input.siteId, item, "striking_distance", targetUrl, targetUrl ? pages[targetUrl] ?? null : null),
    );
  }

  for (const item of input.lowCtr) {
    const targetUrl = queryTargets[item.query] || null;
    add(
      `query:${item.query.toLowerCase()}`,
      buildFromKeyword(input.siteId, item, "low_ctr", targetUrl, targetUrl ? pages[targetUrl] ?? null : null),
    );
  }

  for (const item of input.decay) {
    const page = pages[item.url] ?? null;
    const kind: ContentActionKind = "refresh_decaying_page";
    const expectedClicks = Math.max(0, item.previousClicks - item.currentClicks);
    const impact = impactFromClicks(expectedClicks);
    const confidence = item.previousClicks >= 50 ? 82 : 64;
    const effort = effortFor(kind);
    add(`url:${item.url}`, {
      id: actionId(input.siteId, `content_decay:${item.url}`),
      kind,
      format: formatFor(kind),
      title: titleFor(kind, "", item.url),
      primaryQuery: "",
      targetUrl: item.url,
      intent: "commercial",
      signals: ["content_decay"],
      evidence: {
        current_clicks: item.currentClicks,
        previous_clicks: item.previousClicks,
        change_pct: round(item.changePct, 1),
        page_title: page?.title || null,
        page_words: page?.wordCount ?? null,
        page_content_score: page?.contentScore ?? null,
      },
      page,
      impact,
      confidence,
      effort,
      score: round(impact * 0.55 + confidence * 0.25 + (100 - effort) * 0.2),
      expectedClicks: round(expectedClicks),
      recommendedAction: recommendedActionFor(kind),
    });
  }

  for (const item of input.cannibal) {
    const top = item.pages[0];
    const page = top ? pages[top.url] ?? null : null;
    const kind: ContentActionKind = "consolidate_pages";
    const expectedClicks = Math.max(0, item.pages.reduce((sum, page) => sum + page.clicks, 0) * 0.15);
    const impact = impactFromClicks(expectedClicks);
    const confidence = top && top.impressions >= 100 ? 72 : 56;
    const effort = effortFor(kind);
    add(`query:${item.query.toLowerCase()}`, {
      id: actionId(input.siteId, `cannibalization:${item.query}`),
      kind,
      format: formatFor(kind),
      title: titleFor(kind, item.query, top?.url ?? null),
      primaryQuery: item.query,
      targetUrl: top?.url ?? null,
      intent: classifySearchIntent(item.query),
      signals: ["cannibalization"],
      evidence: {
        competing_pages: item.pages.length,
        top_page_clicks: top?.clicks ?? 0,
        top_page_impressions: top?.impressions ?? 0,
        page_title: page?.title || null,
        page_words: page?.wordCount ?? null,
        page_content_score: page?.contentScore ?? null,
      },
      page,
      impact,
      confidence,
      effort,
      score: round(impact * 0.55 + confidence * 0.25 + (100 - effort) * 0.2),
      expectedClicks: round(expectedClicks),
      recommendedAction: recommendedActionFor(kind),
    });
  }

  const actions = [...byKey.values()].sort(
    (a, b) => b.score - a.score || b.expectedClicks - a.expectedClicks || a.title.localeCompare(b.title),
  );

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    summary: {
      total: actions.length,
      highPriority: actions.filter((action) => action.score >= 65).length,
      articles: actions.filter((action) => action.format === "article").length,
      pageUpdates: actions.filter((action) => action.format === "page_update").length,
      metadata: actions.filter((action) => action.format === "metadata").length,
      expectedClicks: round(actions.reduce((sum, action) => sum + action.expectedClicks, 0)),
    },
    actions,
  };
}
