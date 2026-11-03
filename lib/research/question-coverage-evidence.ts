import type { PrismaClient } from "@prisma/client";

import { generateQuestionSet } from "@/lib/aeo/question-set";
import { storeEvidenceRecord } from "@/lib/funnel/evidence";

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

export type QuestionCoverageDb = Pick<PrismaClient, "businessKnowledgeDocument"> &
  Parameters<typeof storeEvidenceRecord>[0];

export type QuestionCoverageResult = {
  document: boolean;
  questions: number;
  stored: number;
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
  if (!document) return { document: false, questions: 0, stored: 0 };

  const fields = (document.revisions[0]?.fields ?? {}) as Record<string, unknown>;
  const set = generateQuestionSet({ businessKnowledge: { fields } }, { limit: opts.limit ?? 10 });
  if (set.questions.length === 0) {
    return { document: true, questions: 0, stored: 0, emptyReason: set.emptyReason ?? "no_questions" };
  }

  const observedAt = opts.observedAt ?? document.revisions[0]?.createdAt ?? new Date();
  let stored = 0;
  for (const question of set.questions) {
    await storeEvidenceRecord(db, {
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
    stored += 1;
  }
  return { document: true, questions: set.questions.length, stored };
}
