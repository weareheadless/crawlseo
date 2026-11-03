import type { PrismaClient } from "@prisma/client";

import { visibilityCohorts, type VisibilityCohort } from "@/lib/dataforseo/ai-visibility-adapter";

/**
 * DS-06 read projection: a safe view over stored AI-visibility evidence.
 *
 * Rules the projection enforces, so no consumer can break them:
 *  - a question with no observation is `unobserved`, which is not zero;
 *  - an observed question we were not cited in is `uncited`, which is a
 *    measurement;
 *  - cohorts (surface/model/locale) are reported separately and never summed;
 *  - freshness is stated, because an answer from three weeks ago is not today.
 */

export type VisibilityDb = Pick<PrismaClient, "evidenceRecord">;

export type QuestionState = "cited" | "uncited" | "unobserved";

export type VisibilityQuestion = {
  question: string;
  state: QuestionState;
  /** Last time this question was asked, null when never observed. */
  observedAt: Date | null;
  samples: number | null;
  citedCount: number | null;
  competitorCitedCount: number | null;
};

export type VisibilityProjection = {
  cohorts: Array<
    VisibilityCohort & {
      /** Most recent observation in this cohort, for freshness display. */
      latestObservedAt: Date | null;
    }
  >;
  questions: VisibilityQuestion[];
  /** Total observed questions across all cohorts (not a visibility score). */
  observedQuestions: number;
  /** Questions in the project's set that were never asked. */
  unobservedQuestions: number;
  /** True when more than one cohort exists: the UI must not show one number. */
  mixedCohorts: boolean;
  /** Declared limitation, shown verbatim in the UI. */
  note: string;
};

type StoredObservation = {
  dimensions: unknown;
  metrics: unknown;
  observedAt: Date;
};

function readObservation(row: StoredObservation) {
  const dims = (row.dimensions ?? {}) as { question?: string; surface?: string; model?: string | null; locale?: string };
  const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
  return {
    question: dims.question ?? "",
    surface: dims.surface ?? "unknown",
    model: dims.model ?? null,
    locale: dims.locale ?? "unknown",
    cited: metrics["provider:citedCount"]?.value ?? 0,
    competitorCited: metrics["provider:competitorCitedCount"]?.value ?? 0,
    samples: metrics["provider:samples"]?.value ?? null,
    observedAt: row.observedAt,
  };
}

export async function getVisibilityProjection(
  db: VisibilityDb,
  opts: { projectId: string; siteId?: string | null }
): Promise<VisibilityProjection> {
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId: opts.projectId,
      siteId: opts.siteId ?? undefined,
      kind: "ai_visibility_observation",
      supersededById: null,
    },
    orderBy: { observedAt: "desc" },
    select: { dimensions: true, metrics: true, observedAt: true },
  });

  const observations = rows.map(readObservation).filter((row) => row.question);
  const cohorts = visibilityCohorts(
    observations.map((row) => ({ surface: row.surface, model: row.model, locale: row.locale, question: row.question, cited: row.cited }))
  ).map((cohort) => {
    const inCohort = observations.filter(
      (row) => row.surface === cohort.surface && (row.model ?? null) === cohort.model && row.locale === cohort.locale
    );
    const latest = inCohort.reduce<Date | null>((best, row) => (!best || row.observedAt > best ? row.observedAt : best), null);
    return { ...cohort, latestObservedAt: latest };
  });

  // Per-question state: the newest observation wins, and "never asked" is its
  // own state rather than a zero.
  const byQuestion = new Map<string, ReturnType<typeof readObservation>>();
  for (const row of observations) {
    const existing = byQuestion.get(row.question);
    if (!existing || row.observedAt > existing.observedAt) byQuestion.set(row.question, row);
  }

  const questions: VisibilityQuestion[] = [...byQuestion.entries()]
    .map(([question, row]) => ({
      question,
      state: (row.cited > 0 ? "cited" : "uncited") as QuestionState,
      observedAt: row.observedAt,
      samples: row.samples,
      citedCount: row.cited,
      competitorCitedCount: row.competitorCited,
    }))
    .sort((a, b) => a.question.localeCompare(b.question));

  // Questions the project tracks but has never asked come from the coverage
  // contract, not from this evidence, so they are reported as a count only.
  const coverageRows = await db.evidenceRecord.findMany({
    where: { projectId: opts.projectId, kind: "question_coverage", supersededById: null },
    select: { dimensions: true },
  });
  const trackedQuestions = new Set(
    coverageRows.map((row) => (row.dimensions as { question?: string } | null)?.question).filter((q): q is string => Boolean(q))
  );
  const unobserved = [...trackedQuestions].filter((question) => !byQuestion.has(question));

  const mixedCohorts = cohorts.length > 1;

  return {
    cohorts,
    questions,
    observedQuestions: questions.length,
    unobservedQuestions: unobserved.length,
    mixedCohorts,
    note: mixedCohorts
      ? "Answers come from different engines, models or locales. They are reported per cohort and must not be added together."
      : "Unobserved questions are unknown, not zero. An observed question we were not cited in is a measurement.",
  };
}
