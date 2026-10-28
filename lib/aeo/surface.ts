import type { ObservationRecord } from "./observation-types";

export type EvaluationVerdict = "not_asked" | "no_observation" | "answer_absent" | "brand_absent" | "brand_present" | "no_brand_mention" | "failed" | "over_budget";
export type SurfaceProjection = {
  surface: string;
  verdict: EvaluationVerdict;
  observation: ObservationRecord | null;
  answerExcerpt: string | null;
  citedUrls: string[];
  citedDomains: string[];
  citedDomainsFrequency: Array<{ domain: string; count: number }>;
  competitorOverlapCount: number;
  competitorDomains: string[];
  citationsTruncated: boolean;
  diff: null | { citationAdded: string[]; citationRemoved: string[]; answerChanged: boolean };
};

const SURFACES = ["perplexity_api", "ai_overview"] as const;
const stringList = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
const domain = (value: string) => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const key = (row: ObservationRecord) => `${row.question}\0${row.modelSurface}`;

export function projectEvaluationSurface(input: {
  projectId: string;
  questions: string[];
  generatedQuestions?: Array<{ text: string; version: string }>;
  emptyReason?: string;
  locale?: string | null;
  observations: ObservationRecord[];
  brandOfInterest?: string;
  competitorUrls?: string[];
  compareRuns?: { before: string; after: string };
  /** Failed/over-budget outcomes are only surfaced when explicitly attributable to a question/surface. */
  outcomes?: Array<{ projectId: string; question: string; surface: string; runId: string; state: "failed" | "over_budget" }>;
  maxItems?: number;
}) {
  const maxItems = Math.max(1, Math.min(100, Math.floor(input.maxItems ?? 20)));
  const rows = input.observations.filter((row) => row.projectId === input.projectId);
  const latest = new Map<string, ObservationRecord>();
  for (const row of [...rows].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())) if (!latest.has(`${key(row)}\0${row.questionSetVersion}`)) latest.set(`${key(row)}\0${row.questionSetVersion}`, row);
  const newestObservation = [...rows].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
  const chosenVersion = input.generatedQuestions?.[0]?.version ?? newestObservation?.questionSetVersion ?? null;
  const comparatorRows = input.compareRuns && chosenVersion ? rows.filter((r) => r.questionSetVersion === chosenVersion && [input.compareRuns!.before, input.compareRuns!.after].includes(r.runId ?? "")) : [];
  const competitorDomains = new Set((input.competitorUrls ?? []).map(domain).filter((d): d is string => Boolean(d)));
  const generated = [...new Map((input.generatedQuestions ?? []).map((q) => [q.text, q])).values()];
  const generatedTexts = new Set(generated.map((q) => q.text));
  const oldQuestions = [...new Set(input.questions)].filter((question) => !generatedTexts.has(question)).map((question) => {
    const row = [...rows].filter((item) => item.question === question).sort((a,b) => b.observedAt.getTime()-a.observedAt.getTime())[0];
    return { text: question, version: row?.questionSetVersion ?? chosenVersion ?? "", origin: "earlier" as const };
  });
  const questionDescriptors = [...generated.map((q) => ({ text: q.text, version: q.version, origin: "generated" as const })), ...oldQuestions];
  const questions = questionDescriptors.map((q) => q.text);
  const projected = questionDescriptors.slice(0, maxItems).map(({ text: question, version, origin }) => ({ question, questionSetVersion: version, origin, surfaces: SURFACES.map((surface): SurfaceProjection => {
    const observation = latest.get(`${question}\0${surface}\0${version}`) ?? null;
    const matches = rows.filter((r) => r.question === question && r.modelSurface === surface && r.questionSetVersion === version);
    const before = input.compareRuns && chosenVersion ? matches.filter((r) => r.runId === input.compareRuns!.before).sort((a,b) => b.observedAt.getTime()-a.observedAt.getTime())[0] : undefined;
    const after = input.compareRuns && chosenVersion ? matches.filter((r) => r.runId === input.compareRuns!.after).sort((a,b) => b.observedAt.getTime()-a.observedAt.getTime())[0] : undefined;
    const citations = stringList(observation?.citedSources);
    const frequencies = new Map<string, number>();
    for (const item of rows.filter((r) => r.question === question && r.modelSurface === surface && r.questionSetVersion === chosenVersion)) for (const url of stringList(item.citedSources)) { const d = domain(url); if (d) frequencies.set(d, (frequencies.get(d) ?? 0) + 1); }
    const citedDomains = [...new Set(citations.map(domain).filter((d): d is string => Boolean(d)))];
    const failed = input.outcomes?.find((outcome) => outcome.projectId === input.projectId && outcome.question === question && outcome.surface === surface && (!input.compareRuns || outcome.runId === input.compareRuns.after));
    const brands = stringList(observation?.mentionedBrands).map((v) => v.toLocaleLowerCase());
    const verdict: EvaluationVerdict = !observation ? (failed?.state ?? (origin === "generated" ? "not_asked" : "no_observation")) : observation.aiAnswerPresent === false ? "answer_absent" : input.brandOfInterest ? (brands.includes(input.brandOfInterest.toLocaleLowerCase()) ? "brand_present" : "brand_absent") : brands.length ? "brand_present" : "no_brand_mention";
    const visibleCitations = citations.slice(0, maxItems);
    return { surface, verdict, observation, answerExcerpt: observation?.answerText?.slice(0, 600) ?? null, citedUrls: visibleCitations, citedDomains: citedDomains.slice(0, maxItems), citedDomainsFrequency: [...frequencies].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,maxItems).map(([d,count]) => ({ domain: d, count })), competitorOverlapCount: citations.filter((url) => { const d = domain(url); return d !== null && competitorDomains.has(d); }).length, competitorDomains: citedDomains.filter((d) => competitorDomains.has(d)).slice(0,maxItems), citationsTruncated: citations.length > maxItems || citedDomains.length > maxItems, diff: before && after ? { citationAdded: stringList(after.citedSources).filter((url) => !stringList(before.citedSources).includes(url)).slice(0,maxItems), citationRemoved: stringList(before.citedSources).filter((url) => !stringList(after.citedSources).includes(url)).slice(0,maxItems), answerChanged: before.answerText !== after.answerText } : null };
  }) }));
  return { projectId: input.projectId, questionSetVersion: chosenVersion, locale: input.locale ?? newestObservation?.locale ?? null, emptyReason: input.emptyReason ?? null, latestAskedAt: newestObservation?.observedAt ?? null, questions: projected, truncatedQuestions: questions.length > maxItems, truncationLimit: maxItems, comparisonVersionMatched: comparatorRows.length > 0 };
}
