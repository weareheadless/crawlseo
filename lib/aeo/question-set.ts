import { createHash } from "node:crypto";
import type { GeneratedQuestion, QuestionIntent, QuestionProvenance, QuestionSet } from "./question-set-types";

type RecordValue = Record<string, unknown>;
export type QuestionSetInput = {
  businessKnowledge?: { revision?: number; acceptedRevision?: number | null; documentId?: string; fields?: Record<string, unknown> } | null;
  profile?: { audience?: unknown; topics?: unknown; services?: unknown; market?: unknown; country?: string | null; language?: string | null; locale?: string | null } | null;
  research?: { runs?: Array<{ id: string; questions?: unknown }>; findings?: Array<{ id: string; runId?: string; theme?: string; summary?: string }> } | null;
  keywordEvidence?: unknown;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");
function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object" && "value" in value) return strings((value as RecordValue).value);
  return [];
}
function factValues(fields: Record<string, unknown> | undefined, key: string) { return strings(fields?.[key]); }
function buildQuestion(text: string, intent: QuestionIntent, provenance: QuestionProvenance[]): GeneratedQuestion {
  const normalized = clean(text);
  return { id: `q_${hash({ intent, text: normalized.toLocaleLowerCase() }).slice(0, 16)}`, text: `${normalized}?`, intent, provenance };
}

/** Pure, provider-neutral question-set generator. Inputs may be Prisma-shaped JSON or plain values. */
export function generateQuestionSet(input: QuestionSetInput, options: { limit?: number } = {}): QuestionSet {
  const business = input.businessKnowledge;
  const fields = business?.fields;
  const name = factValues(fields, "businessName")[0];
  const services = [...new Set([...factValues(fields, "services"), ...strings(input.profile?.services)])];
  const topics = [...new Set([...strings(input.profile?.topics), ...strings(input.keywordEvidence)])];
  const audience = strings(input.profile?.audience);
  const location = factValues(fields, "location")[0] ?? factValues(fields, "serviceArea")[0] ?? strings(input.profile?.market)[0];
  const differentiator = factValues(fields, "differentiators")[0];
  const trust = factValues(fields, "verifiedTrustEvidence")[0];
  const concern = factValues(fields, "concerns")[0];
  const offer = services[0] ?? topics[0];
  const businessPresent = Boolean(name || services.length || topics.length || location || differentiator || trust || concern || factValues(fields, "audienceMotivations").length);
  const locale = { country: input.profile?.country ?? null, language: input.profile?.language ?? input.profile?.locale ?? null };
  if (!businessPresent) return { contract: "aeo-question-set/1", version: hash({ contract: "aeo-question-set/1", input, locale }), locale, questions: [], provenance: [{ kind: "not_recorded" }], emptyReason: "no_business_data" };

  const provenance: QuestionProvenance[] = [];
  if (business?.acceptedRevision != null) provenance.push({ kind: "business_knowledge", ...(business.documentId ? { documentId: business.documentId } : {}), revision: business.acceptedRevision });
  else provenance.push({ kind: "not_recorded" });
  for (const run of input.research?.runs ?? []) provenance.push({ kind: "research_run", id: run.id });
  for (const finding of input.research?.findings ?? []) provenance.push({ kind: "research_finding", id: finding.id, ...(finding.runId ? { runId: finding.runId } : {}) });
  if (input.profile && (audience.length || topics.length || services.length || location)) provenance.push({ kind: "profile" });
  if (input.research?.runs?.length === 0 && input.research?.findings?.length === 0) provenance.push({ kind: "not_recorded" });
  const candidates: Array<[QuestionIntent, string]> = [];
  if (offer) candidates.push(["discovery", `Where can I find ${offer}${name ? ` from ${name}` : ""}?`]);
  if (offer) candidates.push(["comparison", `How does ${name ?? "this business"} compare with other ${offer} providers?`]);
  if (offer) candidates.push(["suitability", `Is ${offer} right for ${audience[0] ?? "my needs"}?`]);
  if (offer && location) candidates.push(["local", `Who offers ${offer} in ${location}?`]);
  if (offer) candidates.push(["trust_risk", `Is ${name ?? offer} trustworthy, and what should I know before choosing?`]);
  if (offer && differentiator) candidates.push(["comparison", `What makes ${name ?? "this business"} different for ${offer}?`]);
  if (offer && concern) candidates.push(["trust_risk", `How does ${name ?? "this business"} address ${concern}?`]);
  if (offer && trust) candidates.push(["trust_risk", `What verified evidence supports ${name ?? "this business"}'s claims about ${trust}?`]);
  for (const run of input.research?.runs ?? []) for (const q of strings(run.questions)) candidates.push(["discovery", q]);
  for (const finding of input.research?.findings ?? []) if (finding.summary?.trim()) candidates.push([/compar|alternat/i.test(`${finding.theme} ${finding.summary}`) ? "comparison" : "suitability", finding.summary.trim()]);
  const unique = new Map<string, GeneratedQuestion>();
  for (const [intent, text] of candidates) {
    const question = buildQuestion(text, intent, provenance);
    const key = question.text.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, question);
  }
  const max = Math.max(1, Math.min(20, Math.floor(options.limit ?? 12)));
  const questions = [...unique.values()].slice(0, max);
  const version = hash({ contract: "aeo-question-set/1", input, locale, provenance, questions });
  return { contract: "aeo-question-set/1", version, locale, questions, provenance };
}
