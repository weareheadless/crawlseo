import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { OBSERVATION_PROVIDER_SURFACES, type CreateObservationInput, type ObservationProjection, type ObservationRecord } from "./observation-types";

type ObservationDb = Pick<typeof db, "aIVisibilityObservation">;
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function validate(input: CreateObservationInput): void {
  if (input.requestStatus !== "succeeded") throw new Error(`Cannot store ${input.requestStatus} request as an observation`);
  if (!OBSERVATION_PROVIDER_SURFACES[input.provider]?.includes(input.surface as never)) throw new Error("Unsupported provider/surface");
  if (!input.questionSetVersion.trim() || !input.projectId.trim() || !input.question.trim()) throw new Error("Project, question and question-set version are required");
  if (!input.promptText.trim() || input.promptText.length > 4000) throw new Error("Prompt must contain 1-4000 characters");
  if (!input.locale.trim() || input.locale.length > 35) throw new Error("Invalid locale");
  if (!Number.isFinite(input.askedAt.getTime())) throw new Error("Invalid asked-at timestamp");
  if ((input.answerText?.length ?? 0) > 12000) throw new Error("Answer exceeds 12000 characters");
  if (input.aiAnswerPresent && !input.answerText?.trim()) throw new Error("Present answer requires answer text");
  if (!input.aiAnswerPresent && input.answerText?.trim()) throw new Error("Absent answer cannot contain answer text");
}

export async function createObservation(input: CreateObservationInput, client: ObservationDb = db) {
  validate(input);
  const hash = createHash("sha256").update(JSON.stringify([input.projectId, input.question, input.provider, input.surface, input.questionSetVersion, input.askedAt.toISOString(), input.promptText, input.answerText ?? null, input.aiAnswerPresent, input.citedSources ?? [], input.mentionedBrands ?? []])).digest("hex");
  const data = { projectId: input.projectId, question: input.question, provider: input.provider, modelSurface: input.surface, observedAt: input.askedAt, questionSetVersion: input.questionSetVersion, sourceKind: "provider_api" as const, rawExportReference: `run:${input.runId}`, denominator: 1, coverage: { answerObserved: true }, mentions: input.aiAnswerPresent ? input.mentionedBrands ?? [] : undefined, citations: input.aiAnswerPresent ? input.citedSources ?? [] : undefined, observationHash: hash, version: 1, answerText: input.answerText ?? null, promptText: input.promptText, locale: input.locale, country: input.country ?? null, device: input.device ?? null, aiAnswerPresent: input.aiAnswerPresent, modelVersion: input.modelVersion ?? null, runId: input.runId, citedSources: input.aiAnswerPresent ? input.citedSources ?? [] : undefined, mentionedBrands: input.aiAnswerPresent ? input.mentionedBrands ?? [] : undefined };
  return client.aIVisibilityObservation.upsert({
    where: { projectId_question_provider_modelSurface_questionSetVersion_observedAt_observationHash: { projectId: input.projectId, question: input.question, provider: input.provider, modelSurface: input.surface, questionSetVersion: input.questionSetVersion, observedAt: input.askedAt, observationHash: hash } },
    create: data,
    update: {},
  });
}

export async function latestObservations(projectId: string, take = 100, client: ObservationDb = db) {
  if (!projectId.trim()) throw new Error("projectId is required");
  const rows = await client.aIVisibilityObservation.findMany({ where: { projectId, sourceKind: "provider_api" }, orderBy: { observedAt: "desc" }, take: Math.max(1, Math.min(500, Math.floor(take))) });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) { const key = `${row.question}\0${row.modelSurface}`; if (!latest.has(key)) latest.set(key, row); }
  return [...latest.values()];
}

export async function compareObservationRuns(projectId: string, firstRunId: string, secondRunId: string, questionSetVersion: string, client: ObservationDb = db) {
  if (!projectId.trim()) throw new Error("projectId is required");
  const rows = await client.aIVisibilityObservation.findMany({ where: { projectId, sourceKind: "provider_api", questionSetVersion, runId: { in: [firstRunId, secondRunId] } }, orderBy: { observedAt: "asc" }, take: 1000 });
  const key = (r: ObservationRecord) => `${r.question}\0${r.provider}\0${r.modelSurface}`;
  const first = new Map(rows.filter((r) => r.runId === firstRunId).map((r) => [key(r), r]));
  const second = new Map(rows.filter((r) => r.runId === secondRunId).map((r) => [key(r), r]));
  return [...new Set([...first.keys(), ...second.keys()])].map((k) => ({ question: (second.get(k) ?? first.get(k))!.question, surface: (second.get(k) ?? first.get(k))!.modelSurface, before: first.get(k) ?? null, after: second.get(k) ?? null }));
}

export function projectObservation(row: ObservationRecord | null, competitorUrls: string[] = [], brandOfInterest?: string): ObservationProjection {
  const sources = asStrings(row?.citedSources);
  const brands = asStrings(row?.mentionedBrands);
  const verdict = !row ? "no_observation" : row.aiAnswerPresent === false ? "answer_absent" : brandOfInterest && !brands.some((brand) => brand.toLocaleLowerCase() === brandOfInterest.toLocaleLowerCase()) ? "brand_absent" : brands.length ? "answer_present" : "no_brand_mention";
  return { question: row?.question ?? "", surface: row?.modelSurface ?? "", verdict, answerExcerpt: row?.answerText?.slice(0, 400) ?? null, citedUrls: sources, competitorSourceOverlap: sources.filter((url) => competitorUrls.includes(url)) };
}
