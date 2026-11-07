import type { PrismaClient } from "@prisma/client";

import { generateQuestionSet } from "@/lib/aeo/question-set";
import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import {
  isBrandTopic,
  loadTopicTaxonomy,
  queryMatchesTaxonomy,
  queryMatchesTopics,
  stabilizeTopicTaxonomy,
} from "@/lib/research/topic-taxonomy";

/**
 * Bridge: business knowledge → `question_coverage` evidence (plan §3, O5).
 *
 * O5 is "a question in the set has never been observed on an AI surface". That
 * needs a question set and an unobserved marker, which nothing produced: the
 * existing coverage writer records coverage of content that exists.
 *
 * Questions come from the owner's business document through the provider-neutral
 * generator, and are stored as `observed: "false"`. Asking them is the O5 play
 * (the AI visibility collection); this bridge only declares the gap.
 */

export type QuestionCoverageDb = Pick<PrismaClient, "businessKnowledgeDocument" | "siteProfile"> &
  Parameters<typeof storeEvidenceRecord>[0];

/** A business-knowledge fact is stored as `{ value }`, not as a bare string. */
function factText(fields: Record<string, unknown>, key: string): string | null {
  const raw = fields[key];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "value" in raw) {
    const value = (raw as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return null;
}

export type QuestionCoverageResult = {
  document: boolean;
  questions: number;
  stored: number;
  /** Queries the question set drew on, so a set built from two queries is visible. */
  keywords: number;
  /** Questions the limit cut; zero means the set is complete. */
  omitted: number;
  emptyReason?: string;
};

export async function bridgeQuestionCoverageToEvidence(
  db: QuestionCoverageDb,
  opts: { projectId: string; siteId?: string | null; limit?: number; observedAt?: Date }
): Promise<QuestionCoverageResult> {
  const document = await db.businessKnowledgeDocument.findUnique({
    where: { projectId: opts.projectId },
    select: {
      revision: true,
      acceptedRevision: true,
      revisions: { orderBy: { revision: "desc" }, take: 1, select: { fields: true, createdAt: true } },
    },
  });
  if (!document) return { document: false, questions: 0, stored: 0, keywords: 0, omitted: 0 };

  // Questions come from real query patterns first. Business knowledge alone
  // produces template prose ("Who offers <service> in <city>?") that nobody
  // asks and that the taxonomy then filters out, leaving the AEO lane empty.
  const [profile, metricRows, rankRows] = await Promise.all([
    opts.siteId
      ? db.siteProfile.findUnique({ where: { siteId: opts.siteId }, select: { language: true, country: true } })
      : Promise.resolve(null),
    db.evidenceRecord.findMany({
      where: {
        projectId: opts.projectId,
        siteId: opts.siteId ?? null,
        kind: "keyword_metrics",
        supersededById: null,
      },
      select: { dimensions: true, metrics: true },
    }),
    db.evidenceRecord.findMany({
      where: {
        projectId: opts.projectId,
        siteId: opts.siteId ?? null,
        kind: "keyword_rank",
        supersededById: null,
      },
      select: { dimensions: true, metrics: true },
    }),
  ]);
  const keywords = new Map<string, { query: string; volume: number; impressions: number }>();
  const addKeyword = (row: { dimensions: unknown; metrics: unknown }, metric: string) => {
    const dimensions = (row.dimensions ?? {}) as Record<string, unknown>;
    const query = typeof dimensions.query === "string" ? dimensions.query.trim() : "";
    if (!query) return;
    const metrics = (row.metrics ?? {}) as Record<string, { value?: unknown } | undefined>;
    const value = Number(metrics[metric]?.value ?? 0);
    if (!Number.isFinite(value) || value <= 0) return;
    const current = keywords.get(query) ?? { query, volume: 0, impressions: 0 };
    if (metric === "provider:volume") current.volume = Math.max(current.volume, value);
    else current.impressions += value;
    keywords.set(query, current);
  };
  for (const row of metricRows) addKeyword(row, "provider:volume");
  for (const row of rankRows) addKeyword(row, "first_party:impressions");

  // Questions are only asked about demand the business serves. Without the
  // taxonomy, the top keyword by volume is "freediving record", and the AEO
  // lane spends its cap on a question nobody buys coaching for.
  const storedTaxonomy = opts.siteId ? await loadTopicTaxonomy(db, opts.siteId) : null;
  const taxonomy = storedTaxonomy
    ? {
        ...storedTaxonomy,
        topics: stabilizeTopicTaxonomy({
          topics: storedTaxonomy.topics,
          queries: [...keywords.values()],
          pageTexts: [],
        }).topics,
      }
    : null;
  const brandTopics = taxonomy ? taxonomy.topics.filter((topic) => isBrandTopic(topic)) : [];
  const questionQueries = [...keywords.values()].filter(
    (keyword) =>
      (!taxonomy || queryMatchesTaxonomy(taxonomy, keyword.query)) &&
      // Brand questions are asked once from business knowledge, not as a cost
      // question about the name.
      !queryMatchesTopics(brandTopics, keyword.query)
  );

  const fields = (document.revisions[0]?.fields ?? {}) as Record<string, unknown>;
  const set = generateQuestionSet(
    {
      businessKnowledge: { fields },
      profile: {
        // The site's configured language decides the question forms; the
        // business document is the fallback for a site with no profile yet.
        language: profile?.language ?? factText(fields, "language"),
        country: profile?.country ?? factText(fields, "country"),
      },
      keywordEvidence: { queries: questionQueries },
    },
    { limit: opts.limit ?? 12 }
  );
  if (set.questions.length === 0) {
    return { document: true, questions: 0, stored: 0, keywords: questionQueries.length, omitted: 0, emptyReason: set.emptyReason ?? "no_questions" };
  }

  const observedAt = opts.observedAt ?? document.revisions[0]?.createdAt ?? new Date();
  let stored = 0;
  let anchor: string | null = null;
  for (const question of set.questions) {
    const record = await storeEvidenceRecord(db, {
      projectId: opts.projectId,
      siteId: opts.siteId ?? null,
      kind: "question_coverage",
      observedAt,
      producer: "question_set",
      dimensions: {
        question: question.text,
        intent: question.intent,
        // The detector reads this flag: the question is in the set and has never
        // been asked on an AI surface.
        observed: "false",
        questionId: question.id,
      },
      metrics: {},
    });
    anchor ??= record.id;
    stored += 1;
  }
  // A question set that changed must replace the previous one, or the old
  // template questions stay active and the bundle keeps measuring them.
  if (anchor) {
    const existing = await db.evidenceRecord.findMany({
      where: {
        projectId: opts.projectId,
        siteId: opts.siteId ?? null,
        kind: "question_coverage",
        supersededById: null,
        producer: "question_set",
      },
      select: { id: true, dimensions: true },
    });
    const current = new Set(set.questions.map((question) => question.id));
    for (const row of existing) {
      const dimensions = (row.dimensions ?? {}) as Record<string, unknown>;
      if (dimensions.observed !== "false") continue;
      const questionId = typeof dimensions.questionId === "string" ? dimensions.questionId : null;
      if (questionId && current.has(questionId)) continue;
      if (row.id === anchor) continue;
      await db.evidenceRecord.update({ where: { id: row.id }, data: { supersededById: anchor } });
    }
  }
  return { document: true, questions: set.questions.length, stored, keywords: questionQueries.length, omitted: set.omitted ?? 0 };
}
