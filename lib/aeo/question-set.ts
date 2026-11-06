import { createHash } from "node:crypto";
import type { GeneratedQuestion, QuestionIntent, QuestionProvenance, QuestionSet } from "./question-set-types";
import { looksLikeQuestion, questionFromTheme } from "./brand";
import { canonicalKeyword } from "@/lib/research/keyword-identity";

type RecordValue = Record<string, unknown>;
export type QuestionSetInput = {
  businessKnowledge?: { revision?: number; acceptedRevision?: number | null; documentId?: string; fields?: Record<string, unknown> } | null;
  profile?: { audience?: unknown; topics?: unknown; services?: unknown; market?: unknown; country?: string | null; language?: string | null; locale?: string | null } | null;
  research?: { runs?: Array<{ id: string; questions?: unknown }>; findings?: Array<{ id: string; runId?: string; theme?: string; summary?: string }> } | null;
  keywordEvidence?: unknown;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");

type KeywordPattern = { query: string; volume: number; impressions: number };

/**
 * Keyword evidence as query patterns. A caller may pass bare strings, rows with
 * volume, or `{ queries: [...] }`; every shape is accepted because the source is
 * Prisma JSON, not a typed contract.
 */
function keywordPatterns(value: unknown): KeywordPattern[] {
  if (value == null) return [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === "object" && Array.isArray((value as RecordValue).queries)
      ? ((value as RecordValue).queries as unknown[])
      : [value];
  return raw.flatMap((entry) => {
    if (typeof entry === "string") {
      const query = entry.trim();
      return query ? [{ query, volume: 0, impressions: 0 }] : [];
    }
    if (!entry || typeof entry !== "object") return [];
    const row = entry as RecordValue;
    const query = strings(row.query ?? row.keyword)[0];
    if (!query) return [];
    return [{
      query,
      volume: Number(row.volume ?? 0) || 0,
      impressions: Number(row.impressions ?? 0) || 0,
    }];
  });
}

type QuestionForms = {
  cost: (subject: string) => string;
  suitability: (subject: string) => string;
  comparison: (subject: string) => string;
};

/**
 * Buyer question forms in the site's language. These are not translated word by
 * word: each language has its own natural way of asking what something costs,
 * whether it is worth it and which one is best.
 */
const QUESTION_FORMS: Record<string, QuestionForms> = {
  en: {
    cost: (s) => `How much does ${s} cost?`,
    suitability: (s) => `Is ${s} worth it?`,
    comparison: (s) => `What is the best ${s}?`,
  },
  es: {
    cost: (s) => `¿Cuánto cuesta ${s}?`,
    suitability: (s) => `¿Vale la pena ${s}?`,
    comparison: (s) => `¿Cuál es el mejor ${s}?`,
  },
  fr: {
    cost: (s) => `Combien coûte ${s} ?`,
    suitability: (s) => `Est-ce que ${s} en vaut la peine ?`,
    comparison: (s) => `Quel est le meilleur ${s} ?`,
  },
  de: {
    cost: (s) => `Was kostet ${s}?`,
    suitability: (s) => `Lohnt sich ${s}?`,
    comparison: (s) => `Was ist das beste ${s}?`,
  },
  pt: {
    cost: (s) => `Quanto custa ${s}?`,
    suitability: (s) => `Vale a pena ${s}?`,
    comparison: (s) => `Qual é o melhor ${s}?`,
  },
  it: {
    cost: (s) => `Quanto costa ${s}?`,
    suitability: (s) => `Vale la pena ${s}?`,
    comparison: (s) => `Qual è il miglior ${s}?`,
  },
};

function formsFor(language: string | null | undefined): QuestionForms {
  const code = (language ?? "en").toLowerCase().slice(0, 2);
  return QUESTION_FORMS[code] ?? QUESTION_FORMS.en;
}

const COST_PHRASES = ["how much", "cuanto cuesta", "cuánto cuesta", "quanto custa", "quanto costa", "combien coute", "combien coûte", "was kostet"];
const COST_WORDS = new Set([
  "price", "prices", "pricing", "cost", "costs", "cheap", "budget", "fee", "fees", "rate", "rates",
  "precio", "precios", "coste", "tarifa", "barato", "presupuesto",
  "prix", "cout", "coût", "tarif",
  "preis", "kosten", "gunstig", "günstig",
  "preco", "preço", "precos", "preços", "barato",
  "prezzo", "prezzi", "economico",
]);
const COMPARISON_PHRASES = ["which is better", "cuál es mejor", "cual es mejor"];
const COMPARISON_WORDS = new Set([
  "best", "top", "vs", "versus", "compare", "comparison", "alternative", "alternatives",
  "mejor", "mejores", "comparar", "comparacion", "comparación", "alternativa",
  "meilleur", "meilleure", "comparer", "alternative",
  "beste", "besten", "vergleich", "alternativ",
  "melhor", "melhores", "comparar", "alternativa",
  "migliore", "confronto", "alternativa",
]);

/** Lower-case, accent-free text for matching, never for output. */
function intentText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function intentWords(value: string): string[] {
  return intentText(value).split(" ").filter(Boolean);
}

function hasIntent(query: string, phrases: string[], words: Set<string>): boolean {
  const text = intentText(query);
  return phrases.some((phrase) => text.includes(intentText(phrase))) || intentWords(query).some((word) => words.has(word));
}

/** The query without the words the question form already supplies. */
function questionSubject(query: string): string {
  const cleaned = clean(query);
  let subject = cleaned;
  for (const phrase of [...COST_PHRASES, ...COMPARISON_PHRASES]) {
    subject = subject.replace(new RegExp(phrase, "gi"), " ");
  }
  const kept = subject
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      const word = intentText(token);
      return !COST_WORDS.has(word) && !COMPARISON_WORDS.has(word);
    });
  return kept.join(" ").replace(/\s+/g, " ").trim() || cleaned;
}
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
  if (!businessPresent) return { contract: "aeo-question-set/1", version: hash({ contract: "aeo-question-set/1", locale, questions: [], provenance: [{ kind: "not_recorded" }], emptyReason: "no_business_data" }), locale, questions: [], provenance: [{ kind: "not_recorded" }], emptyReason: "no_business_data" };

  const businessSource: QuestionProvenance[] = business?.acceptedRevision != null
    ? [{ kind: "business_knowledge", ...(business.documentId ? { documentId: business.documentId } : {}), revision: business.acceptedRevision }]
    : [];
  const profileSource: QuestionProvenance[] = input.profile ? [{ kind: "profile" }] : [];
  const templateSource = (fromProfile = false): QuestionProvenance[] => {
    const sources = [...businessSource, ...(fromProfile ? profileSource : [])];
    return sources.length ? sources : [{ kind: "not_recorded" }];
  };
  const candidates: Array<[QuestionIntent, string, QuestionProvenance[]]> = [];
  // Questions from real query patterns come first: they are what buyers type,
  // and template prose about the business is what the limit should cut, not
  // measured demand.
  const forms = formsFor(input.profile?.language ?? input.profile?.locale);
  const seenKeywords = new Set<string>();
  const patterns = keywordPatterns(input.keywordEvidence)
    .filter((pattern) => clean(pattern.query).length > 0)
    .sort((a, b) => b.volume - a.volume || b.impressions - a.impressions || a.query.localeCompare(b.query))
    // "freediving course" and "freediving courses" are one question, not two;
    // without this the cap fills with variants of the same query.
    .filter((pattern) => {
      const key = canonicalKeyword(pattern.query);
      if (!key || seenKeywords.has(key)) return false;
      seenKeywords.add(key);
      return true;
    });
  for (const pattern of patterns) {
    const source: QuestionProvenance[] = [{ kind: "keyword_evidence", query: pattern.query }];
    const query = clean(pattern.query);
    if (looksLikeQuestion(query)) {
      candidates.push(["discovery", query, source]);
      continue;
    }
    const subject = questionSubject(query);
    if (!subject) continue;
    // Two forms per query: what it costs (or which one is best when the query
    // already asks to compare), and whether it is worth it.
    const comparison = hasIntent(query, COMPARISON_PHRASES, COMPARISON_WORDS);
    candidates.push([
      comparison ? "comparison" : "suitability",
      comparison ? forms.comparison(subject) : forms.cost(subject),
      source,
    ]);
    candidates.push(["suitability", forms.suitability(subject), source]);
  }
  if (offer) candidates.push(["discovery", `Where can I find ${offer}${name ? ` from ${name}` : ""}?`, templateSource(!factValues(fields, "services").length)]);
  if (offer) candidates.push(["comparison", `How does ${name ?? "this business"} compare with other ${offer} providers?`, templateSource(!factValues(fields, "services").length)]);
  if (offer) candidates.push(["suitability", `Is ${offer} right for ${audience[0] ?? "my needs"}?`, templateSource(!factValues(fields, "services").length || !audience.length)]);
  if (offer && location) candidates.push(["local", `Who offers ${offer} in ${location}?`, templateSource(!factValues(fields, "services").length || !factValues(fields, "location").length)]);
  if (offer) candidates.push(["trust_risk", `Is ${name ?? offer} trustworthy, and what should I know before choosing?`, templateSource(!factValues(fields, "services").length)]);
  if (offer && differentiator) candidates.push(["comparison", `What makes ${name ?? "this business"} different for ${offer}?`, templateSource(false)]);
  if (offer && concern) candidates.push(["trust_risk", `How does ${name ?? "this business"} address ${concern}?`, templateSource(false)]);
  if (offer && trust) candidates.push(["trust_risk", `What verified evidence supports ${name ?? "this business"}'s claims about ${trust}?`, templateSource(false)]);
  for (const run of input.research?.runs ?? []) for (const q of strings(run.questions)) {
    // Recorded research text is often a statement; only ask question-shaped text verbatim.
    if (looksLikeQuestion(q)) candidates.push(["discovery", q, [{ kind: "research_run", id: run.id }]]);
  }
  for (const finding of input.research?.findings ?? []) {
    const source: QuestionProvenance[] = [{ kind: "research_finding", id: finding.id, ...(finding.runId ? { runId: finding.runId } : {}) }];
    const summary = finding.summary?.trim() ?? "";
    const theme = finding.theme?.trim() ?? "";
    if (summary && looksLikeQuestion(summary)) candidates.push([/compar|alternat/i.test(`${theme} ${summary}`) ? "comparison" : "suitability", summary, source]);
    else {
      const generated = questionFromTheme(theme || summary);
      if (generated) candidates.push([/compar|alternat/i.test(`${theme} ${summary}`) ? "comparison" : "suitability", generated, source]);
    }
  }
  const unique = new Map<string, GeneratedQuestion>();
  for (const [intent, text, sources] of candidates) {
    const question = buildQuestion(text, intent, sources);
    const key = question.text.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, question);
  }
  const max = Math.max(1, Math.min(20, Math.floor(options.limit ?? 12)));
  const all = [...unique.values()];
  const questions = all.slice(0, max);
  const omitted = Math.max(0, all.length - questions.length);
  const provenance = [...new Map(questions.flatMap((question) => question.provenance).map((source) => [JSON.stringify(source), source])).values()];
  const version = hash({ contract: "aeo-question-set/1", locale, questions: questions.map(({ id, text, intent, provenance: questionSources }) => ({ id, text, intent, provenance: questionSources })), provenance });
  return { contract: "aeo-question-set/1", version, locale, questions, provenance, omitted };
}
