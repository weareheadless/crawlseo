import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { opportunityAnchor } from "@/lib/connectors/opportunity-anchor";
import { rankOf } from "@/lib/funnel/evidence";
import { parseOpportunityProposal, type OpportunityProposal } from "@/lib/funnel/proposal";
import { normalizeConfidence, normalizeEffort } from "@/lib/research/opportunity-drafting";
import { proposalHash } from "@/lib/research/opportunity-generation";
import { businessKnowledgeFields, providerCountry, resolveSiteContext } from "@/lib/site/context";

/**
 * Draft the editorial decision for a rank detector's own rows.
 *
 * The detectors state an observation — "this page ranks 14 for this query and
 * earns no click" — and nothing else. Measured 2026-11-26: 0 of 186 stored
 * striking-distance rows carried a `recommendationDecision`, so the board's
 * measured-demand rows were the only ones with no next step on them. The
 * topic-map drafting cannot fill that gap: it proposes per cluster, and a
 * rank row belongs to a page and a query, not to a proposal the map would
 * invent a second time.
 *
 * The division of labour is the house rule. Code supplies facts: the row's
 * query and page from its own identity, the measured rank window, the page's
 * current title/description/H1s from the latest crawl, and the competitors
 * sampled above us for that query. The model decides the play — what to change
 * so the searcher clicks, or that the row deserves no proposal and why. Code
 * then validates the answer against the one proposal contract the board and
 * the acceptance gate already share (`phase3-v1`), with the fields that are
 * facts of this lane fixed by code rather than asked of the model: the work
 * targets the row's own page, it is an update, and its lane is content.
 *
 * A row whose decision fails the contract is re-proposed once with the
 * rejection reason, and stays undecided when it fails again. Nothing here
 * writes a template decision: an undecided row is an honest row.
 */

/**
 * The detector rows this pass drafts for. O1 and O11 key the same
 * `<query>:<url>` identity and can join once the O2 lane has proven itself on
 * live boards; adding a type here is the only change that needs.
 */
export const RANK_DECISION_TYPES = ["O2_striking_distance"] as const;

export const RANK_DRAFTING_PROMPT_VERSION = "rank-drafting-v1";

/** Transport batching: how many rows one model call carries. Not a cap. */
const ROW_BATCH = 6;
/**
 * Payload bound. A site with more open rank rows than this drafts the first
 * `MAX_ROWS_PER_RUN` (highest score first) and reports the rest in
 * `truncations`, so the bound is never silent.
 */
const MAX_ROWS_PER_RUN = 48;
/** Page-body bound for the prompt; exceeding it is reported per run. */
const CONTENT_SNIPPET_CHARS = 1_200;
/** Nearest competitors above us, per query. Selection by relevance. */
const MAX_COMPETITORS_PER_QUERY = 5;
/** Business facts the model may cite as the "why" of a play. */
const MAX_KNOWLEDGE_FACTS = 4;

export type RankDecisionDb = Pick<
  PrismaClient,
  | "site"
  | "siteProfile"
  | "businessKnowledgeDocument"
  | "opportunity"
  | "evidenceRecord"
  | "evidenceEdge"
  | "crawl"
  | "auditPage"
>;

export type RankDecisionInput = {
  siteId: string;
  mode: "dry-run" | "execute";
  /** Defaults to `RANK_DECISION_TYPES`. */
  types?: readonly string[];
  now?: Date;
  onNote?: (message: string) => void;
  /** Injectable for tests; production never passes it. */
  chat?: typeof chatJson;
};

export type DraftedRankDecision = {
  opportunityId: string;
  dedupKey: string;
  title: string;
  action: string;
  readiness: "actionable" | "needs_investigation";
  decision: OpportunityProposal;
};

export type RankDecisionResult = {
  status: "completed" | "failed";
  detail: string;
  /** Open rows of the drafted types with no decision, before the payload bound. */
  considered: number;
  drafted: number;
  stored: number;
  /** Validated decisions, so a dry run is reviewable. */
  decisions: DraftedRankDecision[];
  /** The model chose not to propose, with its reason. */
  declined: Array<{ dedupKey: string; reason: string }>;
  /** Contract failures that survived the single re-proposal. */
  rejected: Array<{ dedupKey: string; reason: string }>;
  /** Rows code could not assemble facts for; never sent to the model. */
  skipped: Array<{ dedupKey: string; reason: string }>;
  errors: string[];
  truncations: string[];
  model: string | null;
};

type EvidenceRowLite = {
  id: string;
  kind: string;
  dimensions: Prisma.JsonValue | null;
  metrics: Prisma.JsonValue | null;
};

type RowContext = {
  opportunityId: string;
  dedupKey: string;
  observation: { title: string; summary: string };
  queries: string[];
  page: {
    url: string;
    title: string | null;
    description: string | null;
    h1s: string[];
    wordCount: number | null;
    contentSnippet: string | null;
  };
  rank: {
    position: number | null;
    impressions: number | null;
    clicks: number | null;
    ctr: number | null;
    windowDays: number | null;
    targetPosition: number | null;
  };
  competitorsAbove: Array<{ domain: string; position: number; evidenceId: string }>;
  /** Every evidence id this row's decision may cite. */
  allowedEvidence: Map<string, string>;
  /** The rank observation itself; a decision must rest on it. */
  rankEvidenceId: string | null;
};

const RANK_SYSTEM = [
  "You are an SEO strategist deciding the next step for measured search rows of one business.",
  "Write every text in the business's language, given in locale.language. Do not mix languages in one decision.",
  "Each row is one measured fact: a page of this site ranks for a query and is not earning the click. You get the query, the page's current title, meta description, H1s, word count and a body snippet, the measured rank window (position, impressions, clicks, CTR), the position the play targets, and the competitors sampled above us for that query with their evidence ids.",
  "Decide one play per row: what to change on that page so the searcher for that query clicks. The play is usually the title and meta description, sometimes the H1 or the opening paragraph's angle. Be concrete enough that a writer can execute the action without re-reading the data: say what the new title or description must state, in which words, for whom.",
  "It is correct to propose nothing for a row. Decline with a reason when the click gap is not a snippet problem — the query's intent does not match what the business offers, the page is the wrong target, or the row needs a SERP look before any rewrite. A declined row stays on the board as an observation; do not invent work for it.",
  "Set readiness actionable only when the rewrite can be written from what you were given. Use needs_investigation when the SERP, the intent or the page must be checked first, and say what to check in the action.",
  "Use only the supplied facts, URLs and evidence ids. Never invent a metric, a page, a query, a competitor or an evidence id. Never present a competitor's position as ours.",
  "The decision targets the row's own page; that is fixed and not yours to choose. Do not propose a new page or a different URL.",
  "Cite evidence ids from the row's evidence list. Every decision must cite the row's rank observation (kind keyword_rank); cite competitor rows when the play is aimed at a domain above us, and the business fact when the play rests on what the business offers.",
  "Set confidence from the strength of the cited evidence: high when the measured window and the page's current snippet directly support the rewrite, medium when directional, low for a test or an owner judgement. Give a confidenceReason in plain words for the owner; do not paste evidence ids into it.",
  "Return exactly one JSON object: { summary: string, decisions: [{ dedupKey, propose, readiness, title, summary, action, expectedOutcome, effort, confidence, confidenceReason, evidenceIds, reason }] }.",
  "For a declined row return only { dedupKey, propose: false, reason }. propose is true or false. readiness is actionable or needs_investigation. effort is small, medium or large. confidence is high, medium or low.",
  "Keep titles under 120 characters, summaries under 300, actions under 600, expectedOutcome under 300, confidenceReason under 200.",
].join("\n");

const REPROPOSE_SYSTEM = [
  RANK_SYSTEM,
  "",
  "This is a second attempt for the rows marked with previousFailure. Each failed the decision contract for the stated reason. Return a corrected decision for it, or decline it with a reason. Rows without previousFailure were already accepted; do not return them again.",
].join("\n");

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metricNumber(metrics: unknown, key: string): number | null {
  const value = asRecord(metrics)[key];
  const inner = asRecord(value).value;
  return typeof inner === "number" && Number.isFinite(inner) ? inner : null;
}

function dimString(row: EvidenceRowLite, key: string): string | null {
  const value = asRecord(row.dimensions)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dimNumber(row: EvidenceRowLite, key: string): number | null {
  const value = asRecord(row.dimensions)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Fold a query the way the evidence selector does: case, accents and
 * whitespace. Those are facts in every language; a plural or a word order is
 * not, and stays the model's job.
 */
function foldQuery(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function fieldText(fields: Record<string, unknown>, key: string): string | null {
  const field = fields[key];
  if (typeof field === "string" && field.trim()) return field.trim();
  const inner = asRecord(field).value;
  if (typeof inner === "string" && inner.trim()) return inner.trim();
  if (Array.isArray(inner)) return inner.filter((entry): entry is string => typeof entry === "string").join("; ") || null;
  return null;
}

function fieldList(fields: Record<string, unknown>, key: string): string[] {
  const field = fields[key];
  const inner = Array.isArray(field) ? field : asRecord(field).value;
  if (Array.isArray(inner)) return inner.filter((entry): entry is string => typeof entry === "string");
  const single = fieldText(fields, key);
  return single ? single.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean) : [];
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) out.push(rows.slice(index, index + size));
  return out;
}

function h1sOf(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The facts for one row. Returns null with a reason when the row resolves no
 * anchor — a row that names no page and no query has nothing a decision could
 * be about, and guessing one from the title is exactly what this codebase
 * refuses.
 */
function rowContext(
  row: { id: string; dedupKey: string; title: string; summary: string; scoreInputs: Prisma.JsonValue | null },
  anchor: { pageUrl: string | null; queries: string[] },
  facts: {
    evidenceByRow: Map<string, EvidenceRowLite[]>;
    pageByUrl: Map<string, { title: string | null; description: string | null; h1s: Prisma.JsonValue | null; wordCount: number; contentText: string | null }>;
    competitorsByQuery: Map<string, Array<{ domain: string; position: number; evidenceId: string }>>;
    knowledgeEvidence: EvidenceRowLite[];
  },
  truncations: string[]
): { context: RowContext } | { reason: string } {
  if (!anchor.pageUrl || anchor.queries.length === 0) {
    return { reason: "row resolves no page/query anchor from its own record" };
  }

  const evidence = facts.evidenceByRow.get(row.id) ?? [];
  const allowedEvidence = new Map<string, string>();
  for (const entry of evidence) allowedEvidence.set(entry.id, entry.kind);

  const rankRow = evidence.find((entry) => entry.kind === "keyword_rank") ?? null;
  const ourPosition = rankRow ? rankOf(rankRow.metrics) : null;
  // "Above us" means a strictly better (lower) position than our own measured
  // one, the same rule the cluster payload applies. Our own domain cannot be
  // above itself, so it drops out without being named.
  const competitorsAbove: Array<{ domain: string; position: number; evidenceId: string }> = [];
  for (const query of anchor.queries) {
    for (const competitor of facts.competitorsByQuery.get(foldQuery(query)) ?? []) {
      if (ourPosition != null && competitor.position >= ourPosition) continue;
      if (competitorsAbove.some((held) => held.evidenceId === competitor.evidenceId)) continue;
      competitorsAbove.push(competitor);
    }
  }
  for (const competitor of competitorsAbove) allowedEvidence.set(competitor.evidenceId, "competitor_rank");
  for (const fact of facts.knowledgeEvidence) allowedEvidence.set(fact.id, fact.kind);

  const page = facts.pageByUrl.get(anchor.pageUrl);
  const contentText = page?.contentText ?? null;
  let contentSnippet: string | null = null;
  if (contentText) {
    contentSnippet = contentText.slice(0, CONTENT_SNIPPET_CHARS);
    if (contentText.length > CONTENT_SNIPPET_CHARS) {
      // One named line per run, not per row: the bound is the same every time.
      const line = `page bodies were sent truncated to ${CONTENT_SNIPPET_CHARS} characters`;
      if (!truncations.includes(line)) truncations.push(line);
    }
  }

  const worth = asRecord(asRecord(row.scoreInputs).worth);
  const targetPosition = typeof worth.targetPosition === "number" ? worth.targetPosition : null;

  return {
    context: {
      opportunityId: row.id,
      dedupKey: row.dedupKey,
      observation: { title: row.title, summary: row.summary },
      queries: anchor.queries,
      page: {
        url: anchor.pageUrl,
        title: page?.title ?? null,
        description: page?.description ?? null,
        h1s: h1sOf(page?.h1s ?? null),
        wordCount: page ? page.wordCount : null,
        contentSnippet,
      },
      rank: {
        position: rankRow ? rankOf(rankRow.metrics) : null,
        impressions: rankRow ? metricNumber(rankRow.metrics, "first_party:impressions") : null,
        clicks: rankRow ? metricNumber(rankRow.metrics, "first_party:clicks") : null,
        ctr: rankRow ? metricNumber(rankRow.metrics, "first_party:ctr") : null,
        windowDays: rankRow ? dimNumber(rankRow, "windowDays") : null,
        targetPosition,
      },
      competitorsAbove,
      allowedEvidence,
      rankEvidenceId: rankRow?.id ?? null,
    },
  };
}

function rowPayload(context: RowContext) {
  return {
    dedupKey: context.dedupKey,
    observation: context.observation,
    queries: context.queries,
    page: context.page,
    rank: context.rank,
    competitorsAbove: context.competitorsAbove,
    evidence: [...context.allowedEvidence].map(([id, kind]) => ({ id, kind })),
  };
}

type ValidatedDecision = {
  decision: OpportunityProposal;
};

/**
 * Validate one returned decision against the lane's contract. The fields that
 * are facts of this lane — the target page, the lane, the kind — are set here,
 * not accepted from the model; the fields that are judgement are checked and
 * bounded. A failure returns the reason, which feeds the single re-proposal.
 */
function validateDecision(
  raw: unknown,
  context: RowContext
): { validated: ValidatedDecision } | { decline: string } | { failure: string } {
  const row = asRecord(raw);
  if (text(row.dedupKey) !== context.dedupKey) {
    return { failure: "decision does not name this row's dedupKey" };
  }
  if (row.propose === false || text(row.propose) === "false") {
    return { decline: text(row.reason) ?? "the model declined without stating a reason" };
  }
  const readiness = text(row.readiness);
  if (readiness !== "actionable" && readiness !== "needs_investigation") {
    return { failure: "readiness must be actionable or needs_investigation" };
  }
  const title = text(row.title);
  const summary = text(row.summary);
  const action = text(row.action);
  const expectedOutcome = text(row.expectedOutcome);
  if (!title || !summary || !action || !expectedOutcome) {
    return { failure: "title, summary, action and expectedOutcome are all required" };
  }
  const effort = normalizeEffort(text(row.effort));
  if (!effort || effort === "unknown") {
    return { failure: "effort must be small, medium or large" };
  }
  const confidence = normalizeConfidence(text(row.confidence));
  const cited = Array.isArray(row.evidenceIds)
    ? row.evidenceIds.filter((id): id is string => typeof id === "string")
    : [];
  const known = [...new Set(cited.filter((id) => context.allowedEvidence.has(id)))];
  if (known.length === 0) {
    return { failure: cited.length === 0 ? "no evidence ids cited" : "cited evidence ids are not in the row's catalogue" };
  }
  if (context.rankEvidenceId && !known.includes(context.rankEvidenceId)) {
    return { failure: "the decision must cite the row's rank observation" };
  }

  const decision = parseOpportunityProposal({
    schemaVersion: "phase3-v1",
    source: "phase3-rank-drafting",
    lane: "content_business",
    kind: "update",
    readiness,
    title: title.slice(0, 160),
    summary: summary.slice(0, 400),
    whyNow: null,
    evidenceRefs: known.slice(0, 10),
    // The play targets the row's own page. This is a fact of the lane, not a
    // model choice: the anchor authority order reads this decision first, so a
    // decision that pointed elsewhere would silently move the row's page.
    target: { url: context.page.url, newAsset: false, section: text(asRecord(row.target).section)?.slice(0, 120) ?? null },
    action: action.slice(0, 900),
    expectedOutcome: expectedOutcome.slice(0, 400),
    effort,
    confidence,
    confidenceReason: text(row.confidenceReason)?.slice(0, 300) ?? null,
    expiresAt: null,
    topicSlug: null,
    sources: [],
    critique: null,
  });
  if (!decision) return { failure: "the assembled decision does not satisfy the phase3-v1 contract" };
  return { validated: { decision } };
}

export async function draftRankDecisions(
  db: RankDecisionDb,
  input: RankDecisionInput
): Promise<RankDecisionResult> {
  const note = input.onNote ?? (() => {});
  const chat = input.chat ?? chatJson;
  const types = [...(input.types ?? RANK_DECISION_TYPES)];
  const empty = {
    drafted: 0,
    stored: 0,
    decisions: [] as DraftedRankDecision[],
    declined: [] as Array<{ dedupKey: string; reason: string }>,
    rejected: [] as Array<{ dedupKey: string; reason: string }>,
    skipped: [] as Array<{ dedupKey: string; reason: string }>,
    errors: [] as string[],
    truncations: [] as string[],
    model: null as string | null,
  };

  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { id: true, domain: true, projectId: true, retiredAt: true },
  });
  if (!site || site.retiredAt || !site.projectId) {
    return {
      status: "failed",
      detail: !site ? `site ${input.siteId} not found` : site.retiredAt ? `site ${site.domain} is retired` : `site ${site.domain} has no project`,
      considered: 0,
      ...empty,
    };
  }

  // Only board rows: a detected row is the system's to propose for. Accepted
  // and in-progress rows are a person's decision and are never rewritten;
  // parked and closed rows are not on the board and cost no model call.
  const rows = await db.opportunity.findMany({
    where: { projectId: site.projectId, type: { in: types as never }, status: "detected" },
    select: { id: true, type: true, dedupKey: true, title: true, summary: true, scoreInputs: true, recommendationDecision: true, scoreValue: true },
    orderBy: { scoreValue: "desc" },
  });
  const targets = rows.filter((row) => row.recommendationDecision == null);
  const truncations: string[] = [];
  const batched = targets.slice(0, MAX_ROWS_PER_RUN);
  if (targets.length > batched.length) {
    truncations.push(`${targets.length - batched.length} open rows were not drafted: per-run bound is ${MAX_ROWS_PER_RUN}`);
  }
  if (batched.length === 0) {
    return {
      status: "completed",
      detail: `no open ${types.join("/")} rows without a decision`,
      considered: targets.length,
      ...empty,
      truncations,
    };
  }

  const config = contentWriterConfig();
  if (!config) {
    return {
      status: "failed",
      detail: "CONTENT_LLM_API_KEY is not configured",
      considered: targets.length,
      ...empty,
      errors: ["CONTENT_LLM_API_KEY is not configured"],
      truncations,
    };
  }

  // Assemble the facts for every row before any call, so one query loads the
  // crawl, the edges and the competitor rows for the whole run.
  const skipped: Array<{ dedupKey: string; reason: string }> = [];
  const contexts: RowContext[] = [];
  {
    const edges = await db.evidenceEdge.findMany({
      where: { toType: "opportunity" as never, toId: { in: batched.map((row) => row.id) }, relation: "supporting" as never },
      select: { toId: true, fromType: true, fromId: true },
    });
    const evidenceIds = [...new Set(edges.filter((edge) => edge.fromType === "evidence_record").map((edge) => edge.fromId))];
    const evidenceRows = evidenceIds.length > 0
      ? await db.evidenceRecord.findMany({
          where: { id: { in: evidenceIds }, supersededById: null },
          select: { id: true, kind: true, dimensions: true, metrics: true },
        })
      : [];
    const evidenceById = new Map(evidenceRows.map((row) => [row.id, row as EvidenceRowLite]));
    const evidenceByRow = new Map<string, EvidenceRowLite[]>();
    for (const edge of edges) {
      const evidence = edge.fromType === "evidence_record" ? evidenceById.get(edge.fromId) : null;
      if (!evidence) continue;
      evidenceByRow.set(edge.toId, [...(evidenceByRow.get(edge.toId) ?? []), evidence]);
    }

    const crawl = await db.crawl.findFirst({
      where: { siteId: site.id, status: "COMPLETED" as never },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    });
    const anchors = new Map(
      batched.map((row) => [
        row.id,
        opportunityAnchor({ type: row.type, dedupKey: row.dedupKey, scoreInputs: row.scoreInputs, recommendationDecision: null }),
      ])
    );
    const pageUrls = [...anchors.values()].map((anchor) => anchor.pageUrl).filter((url): url is string => Boolean(url));
    const pages = crawl && pageUrls.length > 0
      ? await db.auditPage.findMany({
          where: { crawlId: crawl.id, url: { in: [...new Set(pageUrls)] } },
          select: { url: true, title: true, description: true, h1s: true, wordCount: true, contentText: true },
        })
      : [];
    const pageByUrl = new Map(pages.map((page) => [page.url, page]));

    const knowledgeEvidence = (await db.evidenceRecord.findMany({
      where: { projectId: site.projectId, siteId: site.id, kind: "knowledge_fact" as never, supersededById: null },
      select: { id: true, kind: true, dimensions: true, metrics: true },
      take: MAX_KNOWLEDGE_FACTS,
    })) as EvidenceRowLite[];

    // Competitor rows are matched on the folded query, and their position is
    // read the way the evidence catalogue reads it (CMP-003): `rankAbsolute`
    // first, then the provider position. One line per domain, best position.
    const wantedQueries = new Set([...anchors.values()].flatMap((anchor) => anchor.queries.map(foldQuery)));
    const competitorRows = wantedQueries.size > 0
      ? await db.evidenceRecord.findMany({
          where: { projectId: site.projectId, siteId: site.id, kind: "competitor_rank" as never, supersededById: null },
          select: { id: true, kind: true, dimensions: true, metrics: true },
        })
      : [];
    const competitorsByQuery = new Map<string, Array<{ domain: string; position: number; evidenceId: string }>>();
    for (const competitor of competitorRows as EvidenceRowLite[]) {
      const query = dimString(competitor, "query");
      const domain = dimString(competitor, "domain");
      const position = dimNumber(competitor, "rankAbsolute") ?? metricNumber(competitor.metrics, "provider:position");
      if (!query || !domain || position == null) continue;
      const folded = foldQuery(query);
      if (!wantedQueries.has(folded)) continue;
      const held = competitorsByQuery.get(folded) ?? [];
      const existing = held.find((entry) => entry.domain === domain);
      if (!existing) held.push({ domain, position, evidenceId: competitor.id });
      else if (position < existing.position) existing.position = position;
      competitorsByQuery.set(folded, held);
    }
    for (const held of competitorsByQuery.values()) {
      // Nearest above us first — selection by relevance, capped.
      held.sort((a, b) => a.position - b.position);
      if (held.length > MAX_COMPETITORS_PER_QUERY) held.length = MAX_COMPETITORS_PER_QUERY;
    }

    for (const row of batched) {
      const anchor = anchors.get(row.id)!;
      const built = rowContext(row, anchor, { evidenceByRow, pageByUrl, competitorsByQuery, knowledgeEvidence }, truncations);
      if ("reason" in built) skipped.push({ dedupKey: row.dedupKey, reason: built.reason });
      else contexts.push(built.context);
    }
  }

  const context = await resolveSiteContext(db, site.id);
  const fields = await businessKnowledgeFields(db, site.projectId);
  const business = {
    name: fieldText(fields, "businessName"),
    services: fieldList(fields, "services"),
    location: fieldText(fields, "location"),
    serviceArea: fieldList(fields, "serviceArea"),
    audience: fieldText(fields, "audienceMotivations"),
    differentiators: fieldList(fields, "differentiators"),
  };

  const decisions: DraftedRankDecision[] = [];
  const declined: Array<{ dedupKey: string; reason: string }> = [];
  const rejected: Array<{ dedupKey: string; reason: string }> = [];
  const errors: string[] = [];

  for (const batch of chunks(contexts, ROW_BATCH)) {
    const failures = new Map<string, string>();
    let pending = batch;
    // One re-proposal per batch, carrying the rejection reasons. A second
    // failure is final: the row stays undecided and the report says so.
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
      const payload = {
        business,
        locale: { language: context.language, country: providerCountry(context) ?? context.country ?? null },
        today: (input.now ?? new Date()).toISOString().slice(0, 10),
        rows: pending.map((row) => ({
          ...rowPayload(row),
          ...(attempt > 0 ? { previousFailure: failures.get(row.dedupKey) ?? null } : {}),
        })),
      };
      let parsed: unknown;
      try {
        parsed = await chat({
          config,
          system: attempt === 0 ? RANK_SYSTEM : REPROPOSE_SYSTEM,
          user: JSON.stringify(payload),
          maxTokens: 8_000,
          temperature: 0.2,
          attempts: 2,
          timeoutMs: 240_000,
          jsonMode: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
        errors.push(`drafting call for ${pending.length} rows failed: ${message}`);
        break;
      }

      const record = asRecord(parsed);
      const rawRows = Array.isArray(record.decisions)
        ? record.decisions
        : record.decision && typeof record.decision === "object"
          ? [record.decision]
          : [];
      const returned = new Map<string, Record<string, unknown>>();
      for (const raw of rawRows) {
        const key = text(asRecord(raw).dedupKey);
        if (key) returned.set(key, asRecord(raw));
      }

      const retry: RowContext[] = [];
      failures.clear();
      for (const row of pending) {
        const raw = returned.get(row.dedupKey);
        if (!raw) {
          failures.set(row.dedupKey, "the model returned no decision for this row");
          retry.push(row);
          continue;
        }
        const outcome = validateDecision(raw, row);
        if ("decline" in outcome) {
          declined.push({ dedupKey: row.dedupKey, reason: outcome.decline });
        } else if ("failure" in outcome) {
          failures.set(row.dedupKey, outcome.failure);
          retry.push(row);
        } else {
          decisions.push({
            opportunityId: row.opportunityId,
            dedupKey: row.dedupKey,
            title: outcome.validated.decision.title,
            action: outcome.validated.decision.action,
            readiness: outcome.validated.decision.readiness,
            decision: outcome.validated.decision,
          });
        }
      }
      for (const key of returned.keys()) {
        if (!pending.some((row) => row.dedupKey === key)) {
          rejected.push({ dedupKey: key, reason: "decision names a row that was not in this batch" });
        }
      }
      pending = attempt === 0 ? retry : [];
      if (attempt === 0 && retry.length > 0) {
        note(`re-proposing ${retry.length} row(s) after contract failures`);
      }
      if (attempt === 1) {
        for (const row of retry) {
          rejected.push({ dedupKey: row.dedupKey, reason: failures.get(row.dedupKey) ?? "failed the contract twice" });
        }
      }
    }
  }

  let stored = 0;
  if (input.mode === "execute") {
    for (const drafted of decisions) {
      // The guard keeps a concurrent writer (a weekly run, a re-draft) from
      // being overwritten: the update lands only while the row is still
      // undecided, and a lost race is reported, not retried.
      const updated = await db.opportunity.updateMany({
        where: { id: drafted.opportunityId, recommendationDecision: { equals: Prisma.DbNull } },
        data: {
          // The parsed contract plus its provenance: which prompt and model
          // drafted it. The parser round-trip drops extra fields, so they are
          // attached here, at the write, like the topic map's `topicMapRunId`.
          recommendationDecision: {
            ...drafted.decision,
            promptVersion: RANK_DRAFTING_PROMPT_VERSION,
            model: config.model,
          } as never,
          recommendationVersion: "phase3-v1",
          recommendationFingerprint: proposalHash(drafted.decision),
          recommendationEvidenceId: drafted.decision.evidenceRefs[0] ?? null,
        },
      });
      if (updated.count === 1) stored += 1;
      else skipped.push({ dedupKey: drafted.dedupKey, reason: "row gained a decision while drafting; the drafted one was not written" });
    }
  }

  const detail =
    `${decisions.length} drafted of ${targets.length} open rows` +
    (input.mode === "execute" ? `, ${stored} stored` : " (dry run: nothing stored)") +
    (declined.length > 0 ? `, ${declined.length} declined` : "") +
    (rejected.length > 0 ? `, ${rejected.length} rejected` : "") +
    (skipped.length > 0 ? `, ${skipped.length} skipped` : "");
  note(detail);

  return {
    status: "completed",
    detail,
    considered: targets.length,
    drafted: decisions.length,
    stored,
    decisions,
    declined,
    rejected,
    skipped,
    errors,
    truncations,
    model: config.model,
  };
}
