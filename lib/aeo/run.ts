import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { generateQuestionSet, type QuestionSetInput } from "./question-set";
import { createObservation } from "./observation";
import { evaluatePerplexityQuestion } from "./perplexity";
import { evaluateGoogleAiOverviewQuestion } from "./google-ai-overview";
import { applyCap, normalizeAeoCap } from "./cap";
import type { EvaluationReceipt, RunEvaluationInput } from "./run-types";
import type { ObservationProvider } from "./observation-types";
import type { AeoEvaluationRun } from "@prisma/client";
import { DATAFORSEO_LOCATION_CODES } from "@/lib/dataforseo/locale";

type RunDb = typeof db;
type RunDeps = {
  db: RunDb;
  askPerplexity: typeof evaluatePerplexityQuestion;
  askGoogle: typeof evaluateGoogleAiOverviewQuestion;
  saveObservation: typeof createObservation;
  now: () => Date;
};
const defaults: RunDeps = { db, askPerplexity: evaluatePerplexityQuestion, askGoogle: evaluateGoogleAiOverviewQuestion, saveObservation: createObservation, now: () => new Date() };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];

async function loadQuestionInput(client: RunDb, projectId: string, siteId: string): Promise<{ input: QuestionSetInput; brand: string | null; aliases: string[] }> {
  const [business, profile, runs] = await Promise.all([
    client.businessKnowledgeDocument.findUnique({ where: { projectId } }),
    client.siteProfile.findUnique({ where: { siteId } }),
    client.researchRun.findMany({ where: { siteId }, include: { findings: { select: { id: true, runId: true, theme: true, summary: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const revision = business?.acceptedRevision == null ? null : await client.businessKnowledgeRevision.findUnique({ where: { documentId_revision: { documentId: business.id, revision: business.acceptedRevision } } });
  const fields = object(revision?.fields);
  const businessInput = business ? { revision: business.revision, acceptedRevision: business.acceptedRevision, documentId: business.id, fields } : null;
  const input: QuestionSetInput = { businessKnowledge: businessInput, profile: profile ? { audience: profile.audience, topics: profile.topics, services: profile.services, market: object(profile.constraints).market, country: profile.country, language: profile.language, locale: profile.language } : null, research: { runs: runs.map((run) => ({ id: run.id, questions: object(run.brief).questions ?? run.topics })), findings: runs.flatMap((run) => run.findings) } };
  return { input, brand: typeof fields.businessName === "string" ? fields.businessName : null, aliases: strings(fields.brandAliases) };
}

function receipt(row: AeoEvaluationRun): EvaluationReceipt {
  return { asked: row.asked, stored: row.stored, answerAbsent: row.answerAbsent, failed: row.failed, skippedByCap: row.skippedByCap, costMicros: row.costMicros, providers: row.providers as ObservationProvider[], questionSetVersion: row.questionSetVersion, runId: row.runId, startedAt: row.startedAt.toISOString(), finishedAt: (row.finishedAt ?? row.startedAt).toISOString(), status: row.status };
}

/** Run a bounded, persisted AEO evaluation. A unique durable run row is claimed before any provider call. */
export async function runEvaluation(input: RunEvaluationInput, deps: RunDeps = defaults): Promise<EvaluationReceipt> {
  if (!input.projectId || !input.siteId) throw new Error("projectId and siteId are required");
  if (input.trigger === "action" && !input.actionId?.trim()) throw new Error("actionId is required for action-triggered runs");
  const cap = normalizeAeoCap(input.cap);
  const providers = [...new Set(input.providers ?? ["perplexity", "google"])] as ObservationProvider[];
  if (!providers.length || providers.some((p) => !["perplexity", "google"].includes(p))) throw new Error("At least one supported provider is required");
  const data = await loadQuestionInput(deps.db, input.projectId, input.siteId);
  if (input.question) data.input.research = { ...data.input.research, runs: [...(data.input.research?.runs ?? []), { id: input.actionId ?? "action", questions: [input.question] }] };
  const questionSet = generateQuestionSet(data.input);
  if (input.question) {
    const text = `${input.question.trim().replace(/[?.!]+$/, "")}?`;
    const id = createHash("sha256").update(text.toLocaleLowerCase()).digest("hex").slice(0, 16);
    questionSet.questions = [{ id: `q_${id}`, text, intent: "discovery", provenance: [{ kind: "not_recorded" }] }];
    questionSet.version = createHash("sha256").update(JSON.stringify(["aeo-action-question/1", text])).digest("hex");
  }
  const version = input.questionSetVersion ?? questionSet.version;
  const start = deps.now();
  const runId = input.trigger === "scheduled" ? `weekly:${input.siteId}:${isoWeek(start, input.timeZone ?? "UTC")}` : `action:${input.actionId}`;
  const runModel = deps.db.aeoEvaluationRun;
  let row: AeoEvaluationRun;
  try {
    row = await runModel.create({ data: { projectId: input.projectId, siteId: input.siteId, runId, trigger: input.trigger, actionId: input.actionId ?? null, questionSetVersion: version, providers, cap, startedAt: start, status: "running" } });
  } catch (error) {
    const prior = await runModel.findUnique({ where: { projectId_runId: { projectId: input.projectId, runId } } });
    if (prior) {
      const priorReceipt = receipt(prior);
      if (input.trigger === "action") {
        const observations = await deps.db.aIVisibilityObservation.findMany({ where: { projectId: input.projectId, runId }, select: { id: true } });
        priorReceipt.observationIds = observations.map((observation) => observation.id);
      }
      return priorReceipt;
    }
    throw error;
  }
  const tally = { asked: 0, stored: 0, answerAbsent: 0, failed: 0, skippedByCap: 0, costMicros: 0 };
  const observationIds: string[] = [];
  const remaining = questionSet.questions;
  const brandAliases = data.aliases;
  try {
    for (let qIndex = 0; qIndex < remaining.length; qIndex++) for (const provider of providers) {
      const allowance = applyCap(1, cap, tally.asked);
      if (!allowance.allowed) { tally.skippedByCap++; continue; }
      const q = remaining[qIndex];
      tally.asked++;
      const askedAt = deps.now();
      try {
        if (provider === "perplexity") {
          const result = await deps.askPerplexity({ question: q.text, locale: questionSet.locale.language ?? "en", brandName: data.brand, brandAliases });
          tally.costMicros += Math.max(0, Math.round((result.costEstimate ?? 0) * 1_000_000));
          if (result.status !== "succeeded" && result.status !== "answer_absent") { tally.failed++; continue; }
          const answerAbsent = result.status === "answer_absent";
          const stored = await deps.saveObservation({ projectId: input.projectId, question: q.text, provider, surface: "perplexity_api", questionSetVersion: version, askedAt, requestStatus: "succeeded", answerText: result.answerText, promptText: result.promptText, locale: questionSet.locale.language ?? "en", country: questionSet.locale.country, aiAnswerPresent: !answerAbsent, modelVersion: result.modelVersion, runId, citedSources: result.citedUrls, mentionedBrands: result.mentionedBrands ?? [] });
          observationIds.push(stored.id); tally.stored++; if (answerAbsent) tally.answerAbsent++;
        } else {
          const country = (questionSet.locale.country ?? "US").toUpperCase();
          const result = await deps.askGoogle({ projectId: input.projectId, question: q.text, locale: { languageCode: questionSet.locale.language ?? "en", locationCode: DATAFORSEO_LOCATION_CODES[country] ?? 2840 }, device: "desktop", brand: data.brand, aliases: brandAliases });
          tally.costMicros += Math.max(0, result.costMicros ?? 0);
          if (result.state !== "succeeded" && result.state !== "overview_absent") { tally.failed++; continue; }
          const answerAbsent = result.state === "overview_absent";
          const stored = await deps.saveObservation({ projectId: input.projectId, question: q.text, provider, surface: "ai_overview", questionSetVersion: version, askedAt, requestStatus: "succeeded", answerText: result.answerText, promptText: q.text, locale: questionSet.locale.language ?? "en", country: questionSet.locale.country, device: result.device, aiAnswerPresent: !answerAbsent, runId, citedSources: result.citations ?? [], mentionedBrands: result.brandPresent ? [data.brand ?? ""] : [] });
          observationIds.push(stored.id); tally.stored++; if (answerAbsent) tally.answerAbsent++;
        }
      } catch { tally.failed++; }
    }
    const finish = deps.now();
    const status = tally.failed === 0 ? "completed" : tally.stored === 0 ? "failed" : "partial";
    const final = await runModel.update({ where: { id: row.id }, data: { ...tally, status, errorCode: tally.failed ? "provider_request_failed" : null, finishedAt: finish } });
    return { ...receipt(final), observationIds };
  } catch (error) {
    await runModel.update({ where: { id: row.id }, data: { ...tally, status: "failed", errorCode: error instanceof Error ? error.message.slice(0, 128) : "unexpected_failure", finishedAt: deps.now() } });
    throw error;
  }
}

function isoWeek(date: Date, timeZone: string): string {
  const dateParts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const year = Number(dateParts.find((p) => p.type === "year")?.value);
  const month = Number(dateParts.find((p) => p.type === "month")?.value);
  const day = Number(dateParts.find((p) => p.type === "day")?.value);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)).padStart(2, "0")}`;
}
