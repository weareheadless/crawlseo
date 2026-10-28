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

  const businessSource: QuestionProvenance[] = business?.acceptedRevision != null
    ? [{ kind: "business_knowledge", ...(business.documentId ? { documentId: business.documentId } : {}), revision: business.acceptedRevision }]
    : [];
  const profileSource: QuestionProvenance[] = input.profile ? [{ kind: "profile" }] : [];
  const templateSource = (fromProfile = false): QuestionProvenance[] => {
    const sources = [...businessSource, ...(fromProfile ? profileSource : [])];
    return sources.length ? sources : [{ kind: "not_recorded" }];
  };
  const candidates: Array<[QuestionIntent, string, QuestionProvenance[]]> = [];
  if (offer) candidates.push(["discovery", `Where can I find ${offer}${name ? ` from ${name}` : ""}?`, templateSource(!factValues(fields, "services").length)]);
  if (offer) candidates.push(["comparison", `How does ${name ?? "this business"} compare with other ${offer} providers?`, templateSource(!factValues(fields, "services").length)]);
  if (offer) candidates.push(["suitability", `Is ${offer} right for ${audience[0] ?? "my needs"}?`, templateSource(!factValues(fields, "services").length || !audience.length)]);
  if (offer && location) candidates.push(["local", `Who offers ${offer} in ${location}?`, templateSource(!factValues(fields, "services").length || !factValues(fields, "location").length)]);
  if (offer) candidates.push(["trust_risk", `Is ${name ?? offer} trustworthy, and what should I know before choosing?`, templateSource(!factValues(fields, "services").length)]);
  if (offer && differentiator) candidates.push(["comparison", `What makes ${name ?? "this business"} different for ${offer}?`, templateSource(false)]);
  if (offer && concern) candidates.push(["trust_risk", `How does ${name ?? "this business"} address ${concern}?`, templateSource(false)]);
  if (offer && trust) candidates.push(["trust_risk", `What verified evidence supports ${name ?? "this business"}'s claims about ${trust}?`, templateSource(false)]);
  for (const run of input.research?.runs ?? []) for (const q of strings(run.questions)) candidates.push(["discovery", q, [{ kind: "research_run", id: run.id }]]);
  for (const finding of input.research?.findings ?? []) if (finding.summary?.trim()) candidates.push([/compar|alternat/i.test(`${finding.theme} ${finding.summary}`) ? "comparison" : "suitability", finding.summary.trim(), [{ kind: "research_finding", id: finding.id, ...(finding.runId ? { runId: finding.runId } : {}) }]]);
  const unique = new Map<string, GeneratedQuestion>();
  for (const [intent, text, sources] of candidates) {
    const question = buildQuestion(text, intent, sources);
    const key = question.text.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, question);
  }
  const max = Math.max(1, Math.min(20, Math.floor(options.limit ?? 12)));
  const questions = [...unique.values()].slice(0, max);
  const provenance = [...new Map(questions.flatMap((question) => question.provenance).map((source) => [JSON.stringify(source), source])).values()];
  const version = hash({ contract: "aeo-question-set/1", locale, questions: questions.map(({ id, text, intent, provenance: questionSources }) => ({ id, text, intent, provenance: questionSources })), provenance });
  return { contract: "aeo-question-set/1", version, locale, questions, provenance };
}
