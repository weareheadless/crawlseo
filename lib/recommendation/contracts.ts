import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Canonical recommendation contracts.
 *
 * One packet is the exact evidence an assessment received. One decision is the
 * semantic conclusion drawn from that packet. Code validates identity, references,
 * scope and consistency; it does not reinterpret the conclusion. Every producer,
 * reader and evaluator uses these schemas, so a recommendation cannot mean one
 * thing in the database and another on the board.
 */

export const EVIDENCE_STATES = ["supported", "unverified", "contradicted"] as const;
export const READINESS = ["actionable", "needs_investigation", "research_backlog", "no_action", "rejected"] as const;
export const INTERVENTIONS = [
  "maintain",
  "update_page",
  "improve_journey",
  "create_asset",
  "investigate",
  "technical_fix",
] as const;
export const REVIEW_REQUIREMENTS = ["subject_matter_expert", "legal", "medical", "technical"] as const;
export const BENEFIT_TRACKS = ["customer_value", "organic_growth", "technical_health"] as const;
export const MEASUREMENTS = ["observed_baseline", "forecast", "unquantified"] as const;
export const COVERAGE_STATES = ["answers", "partially_answers", "does_not_answer", "unassessable"] as const;
export const NEED_BASES = [
  "observed_request",
  "observed_repetition",
  "search_observation",
  "published_question",
  "inferred_need",
] as const;
export const TARGET_ROLES = ["update", "link_from", "link_to", "new_asset"] as const;

export type EvidenceState = (typeof EVIDENCE_STATES)[number];
export type Readiness = (typeof READINESS)[number];
export type Intervention = (typeof INTERVENTIONS)[number];
export type ReviewRequirement = (typeof REVIEW_REQUIREMENTS)[number];
export type BenefitTrack = (typeof BENEFIT_TRACKS)[number];
export type Measurement = (typeof MEASUREMENTS)[number];
export type CoverageState = (typeof COVERAGE_STATES)[number];
export type NeedBasis = (typeof NEED_BASES)[number];
export type TargetRole = (typeof TARGET_ROLES)[number];

export const EVIDENCE_PACKET_VERSION = "evidence-packet/2";
export const RECOMMENDATION_DECISION_VERSION = "recommendation-decision/2";
export const RECOMMENDATION_POLICY_VERSION = "recommendation-policy/2";
export const ANALYSIS_RESULT_VERSION = "recommendation-analysis/1";

/**
 * Bounded analysis resources.
 *
 * These are execution limits, not SEO thresholds. They exist so one candidate
 * cannot spend an unbounded amount of money or time, and so a request for more
 * evidence terminates deterministically. Raising them does not make an
 * unsupported recommendation true.
 */
export const ANALYSIS_RESOURCE_POLICY = {
  version: "analysis-budget/1",
  maxModelCalls: 30,
  maxRepairAttempts: 3,
  maxEvidenceRounds: 3,
  maxRequestsPerRound: 6,
  maxRetrievalRequests: 24,
  maxLiveFetches: 12,
  maxTokens: 16_000,
  timeoutMs: 180_000,
  maxRawResponseChars: 60_000,
  /** One run may not exceed this wall-clock budget. */
  maxElapsedMs: 20 * 60_000,
  /** Maximum serialized model input per call. */
  maxInputChars: 400_000,
  /** Total document bytes fetched by one analysis ledger. */
  maxTotalBytes: 8 * 1024 * 1024,
  /** Reuse a completed decision only inside this freshness window. */
  reuseMaxAgeDays: 7,
} as const;

export type AnalysisResourcePolicy = typeof ANALYSIS_RESOURCE_POLICY;

const id = z.string().min(1).max(300);
const shortText = z.string().min(1).max(400);
const longText = z.string().min(1).max(800);
const ref = z.string().min(1).max(300);

export const PacketReferenceSchema = z.object({
  ref: ref,
  /** Optional for model output: the role is inferred from the ref prefix. */
  role: z.enum([
    "need_support",
    "business_fact",
    "page_answer",
    "premise_support",
    "premise_contradiction",
    "search_estimate",
    "technical_observation",
  ]).optional(),
  excerpt: z.string().max(1_200).optional(),
  note: z.string().max(500).optional(),
});

export const PacketPageSchema = z.object({
  id,
  url: z.string().url(),
  title: z.string().nullable(),
  contentHash: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  retrieval: z.enum(["stored", "live", "rendered", "unavailable"]),
  status: z.number().int(),
  language: z.string().nullable(),
  /** Characters of the page body that were actually supplied and inspected. */
  inspected: z.number().int().nonnegative(),
  /** Known body length at retrieval time, before sectioning. */
  totalChars: z.number().int().nonnegative(),
  /** Start offset of the supplied text within the known body. */
  offset: z.number().int().nonnegative().optional(),
  /** Why retrieval failed or produced no usable text; null when text was read. */
  retrievalNote: z.string().max(400).nullable(),
  /** Which limit caused incompleteness; absent for legacy packets. */
  truncation: z.enum(["none", "sectioned", "byte_limit", "text_limit", "offset"]).optional(),
  sections: z.array(z.object({ id, locator: z.string().max(200), text: z.string() })).max(12),
});

export const PacketLinkSchema = z.object({
  fromPageId: id,
  toUrl: z.string().max(2_000),
  anchor: z.string().max(300),
  /** "observed" means the anchor exists in fetched HTML; status is unverified. */
  observation: z.enum(["observed", "checked"]),
  status: z.number().int().nullable(),
});

export const EvidencePacketSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_PACKET_VERSION),
  packetId: id,
  packetHash: z.string().length(64),
  generatedAt: z.string(),
  projectId: id,
  siteId: id,
  policyVersion: z.string(),
  candidate: z.object({
    findingId: id,
    findingType: z.string(),
    theme: z.string(),
    summary: z.string(),
    premise: z.string().nullable(),
    observedAt: z.string(),
    dedupKey: id,
    sourceIds: z.array(id).max(50),
  }),
  businessFacts: z.array(
    z.object({
      id,
      field: z.string(),
      value: z.string(),
      sourceUrl: z.string().nullable(),
      provenanceKind: z.string(),
      provenanceStatus: z.string(),
      publicationUse: z.string(),
      documentRevision: z.number().int().nullable(),
    })
  ).max(80),
  context: z.object({
    language: z.string().nullable(),
    audience: z.string().nullable(),
    market: z.string().nullable(),
    marketSource: z.string().nullable(),
  }),
  sources: z.array(
    z.object({
      id,
      url: z.string(),
      title: z.string().nullable(),
      provider: z.string(),
      excerpt: z.string().nullable(),
      observedAt: z.string(),
      language: z.string().nullable(),
    })
  ).max(20),
  pages: z.array(PacketPageSchema).max(10),
  links: z.array(PacketLinkSchema).max(200),
  /** Evidence requests already attempted, with their terminal outcome. */
  requests: z.array(
    z.object({
      type: z.enum(["page_text", "source_text", "journey_links", "inventory_search"]),
      target: z.string().max(2_000),
      /** Canonical identity so equivalent URL/id wording cannot evade history. */
      key: z.string().max(2_500).optional(),
      /** Requested start offset for a later section of a long page. */
      offset: z.number().int().nonnegative().optional(),
      status: z.enum(["fulfilled", "partial", "unavailable", "no_progress", "budget_exhausted"]),
      detail: z.string().max(500),
    })
  ).max(40),
  /** What the analysis asked for and what the service did, in order. */
  trace: z.array(
    z.object({
      round: z.number().int().nonnegative(),
      action: z.enum(["packet", "request_evidence", "retrieval", "final_decision", "failure"]),
      detail: z.string().max(600),
      at: z.string(),
    })
  ).max(40),
  inventory: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullable(),
      status: z.number().int(),
      indexable: z.boolean(),
      retrieval: z.enum(["stored", "rendered", "unavailable"]),
    })
  ).max(2_000),
  search: z.array(
    z.object({
      id,
      query: z.string(),
      pageUrl: z.string().nullable(),
      windowStart: z.string().nullable(),
      windowEnd: z.string().nullable(),
      clicks: z.number().nullable(),
      impressions: z.number().nullable(),
      position: z.number().nullable(),
      ctr: z.number().nullable(),
      source: z.string(),
    })
  ).max(40),
  limitations: z.array(z.string().max(500)).max(20),
});

export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;
export type PacketPage = z.infer<typeof PacketPageSchema>;
export type PacketLink = z.infer<typeof PacketLinkSchema>;
export type PacketReference = z.infer<typeof PacketReferenceSchema>;

const AssessmentSchema = z.object({
  state: z.enum(EVIDENCE_STATES),
  rationale: longText,
  /** Packet refs such as fact:services or source:<id>. */
  references: z.array(ref).max(10),
});

const CoverageSchema = z.object({
  pageId: id,
  state: z.enum(COVERAGE_STATES),
  /**
   * What the assessment actually inspected. A truncated page cannot support a
   * whole-page absence claim; the model must name the section scope instead.
   */
  scope: z.enum(["whole_page", "section"]).optional(),
  sectionIds: z.array(id).max(6).optional(),
  rationale: longText,
  excerpts: z.array(z.string().max(1_200)).max(4),
  limitations: z.array(z.string().max(400)).max(4),
});

const InvestigationSchema = z.object({
  question: shortText,
  /**
   * Why a person or qualified reviewer is needed. This is explicit structure, not
   * a prose classifier: external owner/expert input is named rather than inferred
   * from a URL appearing inside an instruction.
   */
  kind: z.enum(["owner_input", "qualified_review", "private_data", "external_evidence"]).optional(),
  inspect: z.array(z.string().max(500)).min(1).max(8),
  decisionCriteria: z.array(z.string().max(500)).min(1).max(8),
  deliverable: shortText,
});

const TargetSchema = z.object({
  pageId: id.nullable(),
  pageUrl: z.string().max(2_000).nullable(),
  sectionId: id.nullable(),
  role: z.enum(TARGET_ROLES),
  rationale: z.string().max(500),
});

const BenefitSchema = z.object({
  track: z.enum(BENEFIT_TRACKS),
  mechanism: longText,
  measurement: z.enum(MEASUREMENTS),
  baselineReference: ref.nullable(),
  assumptions: z.array(z.string().max(400)).max(6),
  uncertainty: z.array(z.string().max(400)).max(6),
});

const ReviewSchema = z.object({
  requirement: z.enum(REVIEW_REQUIREMENTS),
  reason: shortText,
});

/**
 * What the model returns. Identity, packet hash, model and policy versions are
 * added by code after validation; the model cannot choose them.
 */
export const ModelDecisionSchema = z.object({
  question: z.object({
    text: shortText,
    audience: z.string().max(300).nullable(),
    journeyStage: z.string().max(120).nullable(),
    bases: z
      .array(
        z.object({
          basis: z.enum(NEED_BASES),
          references: z.array(ref).max(6),
          note: z.string().max(500),
        })
      )
      .min(1)
      .max(5),
    state: z.enum(EVIDENCE_STATES),
    rationale: longText,
  }),
  premise: AssessmentSchema,
  offerFit: AssessmentSchema,
  coverage: z.array(CoverageSchema).max(10),
  readiness: z.enum(READINESS),
  intervention: z.enum(INTERVENTIONS),
  change: z.string().max(1_000).nullable(),
  /**
   * Required when create_asset is chosen although a supplied page answers the
   * question partially or fully: the distinct intent that existing page does not
   * serve, and why. Code checks that the justification exists; the AI owns it.
   */
  assetJustification: z
    .object({
      distinctIntent: z.string().min(1).max(600),
      whyExistingInsufficient: z.string().min(1).max(600),
    })
    .nullable(),
  investigation: InvestigationSchema.nullable(),
  targets: z.array(TargetSchema).max(6),
  benefits: z.array(BenefitSchema).max(4),
  effort: z.object({
    size: z.enum(["small", "medium", "large", "unknown"]),
    rationale: shortText,
    uncertainty: z.array(z.string().max(400)).max(6),
  }),
  risks: z.array(z.string().max(400)).max(8),
  reviews: z.array(ReviewSchema).max(5),
  success: z.object({
    measure: shortText,
    instrumentation: z.enum(["available", "unavailable", "unknown"]),
    rationale: z.string().max(600),
  }),
  uncertainty: z.array(z.string().max(400)).max(10),
  contradictions: z.array(z.string().max(500)).max(8),
  reasons: z.array(z.string().max(300)).min(1).max(8),
});

export type ModelDecision = z.infer<typeof ModelDecisionSchema>;

/**
 * A request to inspect evidence the service can obtain itself.
 *
 * This is analysis work in progress, not a customer recommendation: it carries no
 * readiness and must be resolved by the service before a final decision.
 */
export const EvidenceRequestSchema = z.object({
  kind: z.literal("request_evidence"),
  requests: z
    .array(
      z.object({
        type: z.enum(["page_text", "source_text", "journey_links", "inventory_search"]),
        /** page:<id>, source:<id>, a URL, or a short discovery query. */
        target: z.string().min(1).max(2_000),
        /** Read a later section of a long page instead of the same prefix again. */
        offset: z.number().int().nonnegative().optional(),
        question: z.string().min(1).max(600),
        whyItMatters: z.string().min(1).max(600),
      })
    )
    .min(1)
    .max(6),
  rationale: z.string().min(1).max(800),
});

export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

export const AnalysisTraceEntrySchema = z.object({
  round: z.number().int().nonnegative(),
  action: z.enum(["packet", "request_evidence", "retrieval", "final_decision", "failure"]),
  detail: z.string().max(600),
  at: z.string(),
});

export type AnalysisTraceEntry = z.infer<typeof AnalysisTraceEntrySchema>;

export const RecommendationDecisionSchema = ModelDecisionSchema.extend({
  schemaVersion: z.literal(RECOMMENDATION_DECISION_VERSION),
  decisionId: id,
  candidateId: id,
  dedupKey: id,
  packetId: id,
  packetHash: z.string().length(64),
  policyVersion: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  assessedAt: z.string(),
  inputLimitations: z.array(z.string().max(500)).max(20),
});

export type RecommendationDecision = z.infer<typeof RecommendationDecisionSchema>;

export type DecisionValidation = {
  ok: boolean;
  errors: string[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** The packet hash covers evidence content, not its generated identity or time. */
export function hashPacket(packet: Omit<EvidencePacket, "packetHash"> & { packetHash?: string }): string {
  // Trace entries record the service's actions and timestamps; they are not
  // evidence and must not change the evidence identity.
  const { packetHash: _ignored, packetId: _packetId, generatedAt: _generatedAt, trace: _trace, ...body } = packet;
  return hashValue(body);
}

export function sealPacket(
  packet: Omit<EvidencePacket, "packetId" | "packetHash" | "generatedAt" | "schemaVersion">,
  now = new Date()
): EvidencePacket {
  const base = {
    ...packet,
    schemaVersion: EVIDENCE_PACKET_VERSION as typeof EVIDENCE_PACKET_VERSION,
    packetId: `packet-${randomUUID()}`,
    generatedAt: now.toISOString(),
  };
  // Hash exactly the JSON form that will be persisted. An in-memory optional
  // property set to `undefined` is dropped by JSON.stringify; hashing the
  // unnormalised object would make the stored packet fail its own hash check.
  const normalised = JSON.parse(JSON.stringify(base)) as typeof base;
  return EvidencePacketSchema.parse({ ...normalised, packetHash: hashPacket(normalised) });
}

export function normaliseExcerpt(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function pageTextContains(page: PacketPage, excerpt: string): boolean {
  return normaliseExcerpt(page.text).includes(normaliseExcerpt(excerpt));
}

function packetRefIds(packet: EvidencePacket): Map<string, PacketReference["role"]> {
  const ids = new Map<string, PacketReference["role"]>();
  for (const fact of packet.businessFacts) ids.set(fact.id, "business_fact");
  for (const source of packet.sources) ids.set(source.id, "need_support");
  for (const page of packet.pages) {
    ids.set(page.id, "page_answer");
    for (const section of page.sections) ids.set(section.id, "page_answer");
  }
  for (const search of packet.search) ids.set(search.id, "search_estimate");
  return ids;
}

function validReference(reference: string, allowed: Map<string, PacketReference["role"]>, errors: string[]): void {
  if (!allowed.has(reference)) errors.push(`reference "${reference}" is not in the supplied packet`);
}

function targetPage(packet: EvidencePacket, pageId: string | null) {
  if (!pageId) return null;
  return packet.pages.find((page) => page.id === pageId) ?? null;
}

/**
 * Validate the decision against the exact packet it claims to use.
 *
 * This is integrity, scope and internal consistency, not a second SEO judgement.
 * It must never rewrite an intervention or invent a fallback recommendation.
 */
export function validateDecision(decision: RecommendationDecision, packet: EvidencePacket): DecisionValidation {
  const errors: string[] = [];
  if (decision.packetHash !== packet.packetHash) errors.push("the decision was not made from this packet");
  if (decision.candidateId !== packet.candidate.findingId) errors.push("the decision names another candidate");

  const allowed = packetRefIds(packet);
  const allReferences = [
    ...decision.question.bases.flatMap((basis) => basis.references),
    ...decision.premise.references,
    ...decision.offerFit.references,
  ];
  for (const reference of allReferences) validReference(reference, allowed, errors);

  // Need support must come from customer/search evidence, not from the site's own
  // page or its business facts. An inferred need is allowed, but must say so.
  for (const basis of decision.question.bases) {
    if (basis.basis === "observed_request" || basis.basis === "observed_repetition") {
      if (basis.references.length === 0) errors.push(`need basis "${basis.basis}" has no source reference`);
      if (basis.references.some((reference) => !reference.startsWith("source:"))) {
        errors.push(`need basis "${basis.basis}" must cite research sources, not site pages or facts`);
      }
    }
    if (basis.basis === "search_observation" && !basis.references.some((reference) => reference.startsWith("search:"))) {
      errors.push("search_observation need basis has no search reference");
    }
    if (basis.basis === "inferred_need" && basis.note.trim().length < 10) {
      errors.push("an inferred need must explain the inference");
    }
  }
  const observedBasis = decision.question.bases.some((basis) =>
    ["observed_request", "observed_repetition", "search_observation", "published_question"].includes(basis.basis)
  );
  const inferredBasis = decision.question.bases.some((basis) => basis.basis === "inferred_need");
  if (decision.question.state === "supported" && !observedBasis) {
    errors.push("a supported need requires an observed or search basis");
  }
  if (decision.question.state === "contradicted") {
    errors.push("a customer question is not contradicted by evidence about the site; record the premise as contradicted instead");
  }

  // Offer fit must rest on a business fact, not on a page mention or a location.
  if (decision.offerFit.state === "supported" && !decision.offerFit.references.some((reference) => reference.startsWith("fact:"))) {
    errors.push("supported offer fit must cite a business fact");
  }

  // A contradicted site premise must be checked against actual page content.
  if (decision.premise.state === "contradicted") {
    const checked = decision.coverage.filter(
      (entry) => (entry.state === "answers" || entry.state === "partially_answers") && entry.excerpts.length > 0
    );
    if (checked.length === 0) errors.push("a contradicted premise needs at least one checked page answer with a verbatim excerpt");
    for (const entry of checked) {
      const page = targetPage(packet, entry.pageId);
      if (!page) {
        errors.push(`coverage names page "${entry.pageId}" that is not in the packet`);
        continue;
      }
      for (const excerpt of entry.excerpts) {
        if (!pageTextContains(page, excerpt)) {
          errors.push(`coverage excerpt for "${page.url}" does not occur in the supplied text`);
        }
      }
    }
  }

  // Coverage claims must be checkable against the supplied page text.
  const coverageByPage = new Map<string, (typeof decision.coverage)[number]>();
  for (const entry of decision.coverage) {
    const page = targetPage(packet, entry.pageId);
    if (!page) {
      errors.push(`coverage names page "${entry.pageId}" that is not in the packet`);
      continue;
    }
    if (coverageByPage.has(entry.pageId)) {
      errors.push(`coverage names page ${page.url} more than once; return one assessment per page`);
      continue;
    }
    coverageByPage.set(entry.pageId, entry);
    if (entry.state === "answers" || entry.state === "partially_answers") {
      if (entry.excerpts.length === 0) errors.push(`coverage "${entry.state}" for ${page.url} has no verbatim excerpt`);
      for (const excerpt of entry.excerpts) {
        if (!pageTextContains(page, excerpt)) errors.push(`coverage excerpt for ${page.url} does not occur in the supplied text`);
      }
    }
    // A negative answer about a page that was never read is not evidence. The
    // model may mark such a page unassessable, or request its text first.
    const scope = entry.scope ?? "whole_page";
    if (scope === "section" && (entry.sectionIds?.length ?? 0) === 0) {
      errors.push(`coverage for ${page.url} is section-scoped but names no inspected section`);
    }
    for (const sectionId of entry.sectionIds ?? []) {
      if (!page.sections.some((section) => section.id === sectionId)) {
        errors.push(`coverage for ${page.url} names section "${sectionId}" that is not in the supplied text`);
      }
    }
    if (entry.state === "does_not_answer") {
      if (page.retrieval === "unavailable" || page.text.trim().length === 0 || page.inspected === 0) {
        errors.push(`coverage for ${page.url} claims no answer, but no page text was inspected`);
      }
      if (page.truncated && scope === "whole_page") {
        errors.push(`coverage for ${page.url} claims the whole page does not answer, but only a truncated section was supplied; assess the relevant section or request the rest`);
      }
    }
    if (entry.state === "unassessable" && page.text.trim().length > 0 && !page.truncated && entry.limitations.length === 0) {
      errors.push(`coverage for ${page.url} is unassessable despite supplied text; state the extraction limitation`);
    }
  }

  const implementation = decision.readiness === "actionable";
  if (implementation) {
    if (decision.question.state !== "supported" && !(decision.question.state === "unverified" && inferredBasis)) {
      errors.push("an actionable recommendation needs a supported need or an explicit inferred-need basis");
    }
    if (decision.offerFit.state !== "supported") errors.push("an actionable recommendation needs supported offer fit");
    if (decision.intervention === "maintain" || decision.intervention === "investigate") {
      errors.push("an actionable recommendation cannot use the maintain or investigate intervention");
    }
    if (decision.benefits.length === 0) errors.push("an actionable recommendation needs at least one benefit mechanism");
    if (!decision.success.measure.trim()) errors.push("an actionable recommendation needs a success measure");
    if (!decision.change?.trim()) errors.push("an actionable recommendation needs a specific change");
  }

  if (decision.readiness === "needs_investigation") {
    if (decision.intervention !== "investigate") errors.push("an investigation readiness must use the investigate intervention");
    if (!decision.investigation) errors.push("an investigation needs a bounded question, evidence to inspect, criteria and deliverable");
    if (decision.investigation && !decision.investigation.kind) {
      errors.push("an investigation must name its external requirement kind");
    }
    if (decision.change?.trim()) errors.push("an investigation must not carry an implementation change");
    // Asking a person to inspect content the packet already contains is unfinished
    // machine analysis. Such a request must be an evidence request instead.
    for (const item of decision.investigation?.inspect ?? []) {
      // Only an exact packet reference is a request to inspect supplied content.
      // A prose instruction that happens to mention a URL is not reclassified by
      // substring matching; the investigation's `kind` names the external need.
      const exact = item.trim().toLowerCase().replace(/\/$/, "");
      const supplied = packet.pages.find(
        (page) =>
          page.text.trim().length > 0 &&
          (exact === page.id.toLowerCase() || exact === page.url.toLowerCase().replace(/\/$/, ""))
      );
      if (supplied) {
        errors.push(`investigation asks to inspect ${supplied.url}, which was already supplied; complete that inspection before returning a final decision`);
      }
    }
  }

  if (decision.readiness === "no_action") {
    if (decision.intervention !== "maintain") errors.push("no_action must use the maintain intervention");
    if (decision.change?.trim()) errors.push("no_action must not propose a change");
    if (decision.targets.length > 0) errors.push("no_action must not name implementation targets");
  }

  if (decision.readiness === "rejected") {
    if (decision.intervention !== "maintain") errors.push("a rejected recommendation must use maintain");
    if (decision.change?.trim()) errors.push("a rejected recommendation must not carry an implementation change");
    if (decision.targets.length > 0) errors.push("a rejected recommendation must not name implementation targets");
  }

  if (decision.readiness === "research_backlog") {
    if (decision.intervention !== "investigate" && decision.intervention !== "maintain") {
      errors.push("research backlog is not implementation work");
    }
    if (decision.change?.trim() && decision.intervention === "maintain") {
      errors.push("research backlog must not carry an implementation change");
    }
  }

  if (decision.intervention === "investigate" && decision.readiness !== "needs_investigation" && decision.readiness !== "research_backlog") {
    errors.push("the investigate intervention is only valid for investigation or backlog");
  }

  if (decision.intervention === "update_page" || decision.intervention === "improve_journey") {
    if (decision.targets.length === 0) errors.push(`${decision.intervention} needs at least one target page`);
    for (const target of decision.targets) {
      const page = targetPage(packet, target.pageId);
      if (!page) {
        errors.push(`target page "${target.pageId ?? "(none)"}" is not in the packet`);
        continue;
      }
      if (target.pageUrl && target.pageUrl !== page.url) errors.push(`target URL ${target.pageUrl} does not match packet page ${page.url}`);
      if (target.sectionId) {
        const section = page.sections.find((entry) => entry.id === target.sectionId);
        if (!section) {
          errors.push(`target section "${target.sectionId}" is not in the supplied text of ${page.url}`);
        }
      }
      if (decision.intervention === "update_page") {
        const coverage = coverageByPage.get(page.id);
        if (!coverage || (coverage.state !== "partially_answers" && coverage.state !== "does_not_answer")) {
          errors.push(`update_page target ${page.url} has no assessed inadequacy`);
        } else if ((coverage.scope ?? "whole_page") === "section") {
          // A section-local absence cannot authorise a whole-page change or a
          // different, uninspected section.
          if (!target.sectionId) {
            errors.push(`update_page target ${page.url} was assessed only at section scope, so it cannot authorise a whole-page change`);
          } else if (!(coverage.sectionIds ?? []).includes(target.sectionId)) {
            errors.push(`update_page target section "${target.sectionId}" on ${page.url} was not one of the assessed sections`);
          }
        }
      }
    }
  }

  if (decision.intervention === "create_asset") {
    const answered = decision.coverage.some((entry) => entry.state === "answers" || entry.state === "partially_answers");
    const unassessable = decision.coverage.some((entry) => entry.state === "unassessable");
    if (unassessable) errors.push("create_asset cannot be justified while relevant page text is unassessable");
    if (decision.coverage.length === 0) errors.push("create_asset needs at least one assessed page that does not answer");
    if (answered) {
      // A distinct intent may justify a new asset, but only with the AI's explicit
      // reasoning. Code checks that it exists; it does not decide whether it is true.
      if (!decision.assetJustification) {
        errors.push("create_asset alongside an answering page needs assetJustification: the distinct intent and why the existing answer is insufficient");
      }
    }
  }

  for (const benefit of decision.benefits) {
    if (benefit.measurement === "forecast" && benefit.assumptions.length === 0) {
      errors.push(`forecast benefit "${benefit.track}" needs its assumptions`);
    }
    if (benefit.measurement === "observed_baseline" && !benefit.baselineReference) {
      errors.push(`observed baseline benefit "${benefit.track}" needs a baseline reference`);
    }
    if (benefit.measurement === "observed_baseline" && benefit.baselineReference && !allowed.has(benefit.baselineReference)) {
      errors.push(`baseline reference "${benefit.baselineReference}" is not in the packet`);
    }
    if (benefit.measurement === "unquantified" && benefit.uncertainty.length === 0) {
      errors.push(`unquantified benefit "${benefit.track}" must state what remains unknown`);
    }
  }

  for (const review of decision.reviews) {
    if (!review.reason.trim()) errors.push(`review requirement "${review.requirement}" needs a reason`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Transport normalisation only.
 *
 * A model may write "Update Page" or "update-page"; that is the same enum name.
 * Anything that changes meaning (for example "partial" → "partially_answers")
 * is refused and returned to the model as a validation error.
 */
const TRANSPORT_ENUMS = {
  readiness: READINESS,
  intervention: INTERVENTIONS,
  evidenceState: EVIDENCE_STATES,
  coverageState: COVERAGE_STATES,
  targetRole: TARGET_ROLES,
  measurement: MEASUREMENTS,
  reviewRequirement: REVIEW_REQUIREMENTS,
  instrumentation: ["available", "unavailable", "unknown"],
  basis: NEED_BASES,
  track: BENEFIT_TRACKS,
  effort: ["small", "medium", "large", "unknown"],
  requestType: ["page_text", "source_text", "journey_links", "inventory_search"],
} as const;

function transportValue(value: unknown, allowed: readonly string[]): unknown {
  if (typeof value !== "string") return value;
  const candidate = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return allowed.includes(candidate) ? candidate : value;
}

export function normaliseModelDecision(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const row = structuredClone(raw) as Record<string, unknown>;
  const set = (target: Record<string, unknown> | undefined, key: string, group: keyof typeof TRANSPORT_ENUMS) => {
    if (!target || !(key in target)) return;
    target[key] = transportValue(target[key], TRANSPORT_ENUMS[group]);
  };
  set(row, "readiness", "readiness");
  set(row, "intervention", "intervention");
  for (const key of ["question", "premise", "offerFit"]) {
    set(row[key] as Record<string, unknown> | undefined, "state", "evidenceState");
  }
  if (Array.isArray(row.coverage)) {
    for (const entry of row.coverage) set(entry as Record<string, unknown>, "state", "coverageState");
  }
  if (Array.isArray(row.targets)) {
    for (const target of row.targets) set(target as Record<string, unknown>, "role", "targetRole");
  }
  if (Array.isArray(row.benefits)) {
    for (const benefit of row.benefits) {
      set(benefit as Record<string, unknown>, "measurement", "measurement");
      set(benefit as Record<string, unknown>, "track", "track");
    }
  }
  if (Array.isArray(row.reviews)) {
    for (const review of row.reviews) set(review as Record<string, unknown>, "requirement", "reviewRequirement");
  }
  if (row.success && typeof row.success === "object") {
    set(row.success as Record<string, unknown>, "instrumentation", "instrumentation");
  }
  if (Array.isArray(row.requests)) {
    for (const request of row.requests) set(request as Record<string, unknown>, "type", "requestType");
  }
  const question = row.question as { bases?: unknown } | undefined;
  if (Array.isArray(question?.bases)) {
    for (const basis of question.bases) set(basis as Record<string, unknown>, "basis", "basis");
  }
  if (row.effort && typeof row.effort === "object") {
    set(row.effort as Record<string, unknown>, "size", "effort");
  }
  return row;
}

export function parseModelDecision(raw: unknown): { ok: true; decision: ModelDecision } | { ok: false; errors: string[] } {
  const parsed = ModelDecisionSchema.safeParse(normaliseModelDecision(raw));
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "decision"}: ${issue.message}`),
    };
  }
  return { ok: true, decision: parsed.data };
}

export type ModelOutput =
  | { kind: "request_evidence"; request: EvidenceRequest }
  | { kind: "final_decision"; decision: ModelDecision };

/** Parse either an evidence request or a final decision from one model answer. */
export function parseModelOutput(raw: unknown): { ok: true; output: ModelOutput } | { ok: false; errors: string[] } {
  const kind = (raw as { kind?: unknown } | null)?.kind;
  if (kind === "request_evidence") {
    const parsed = EvidenceRequestSchema.safeParse(normaliseModelDecision(raw));
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((issue) => `request.${issue.path.join(".") || "body"}: ${issue.message}`),
      };
    }
    return { ok: true, output: { kind: "request_evidence", request: parsed.data } };
  }
  if (kind !== undefined && kind !== "final_decision") {
    return { ok: false, errors: [`kind: expected "request_evidence" or "final_decision", received ${JSON.stringify(kind)}`] };
  }
  const parsed = parseModelDecision(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, output: { kind: "final_decision", decision: parsed.decision } };
}

export type InventorySearchRow = {
  url: string;
  title: string | null;
  contentText: string | null;
};

export type EvidenceRequestValidation = { ok: boolean; errors: string[]; resolved: ResolvedEvidenceRequest[] };

export type ResolvedEvidenceRequest = {
  type: EvidenceRequest["requests"][number]["type"];
  target: string;
  /** Existing packet identity, or a URL/query the service may retrieve. */
  pageId: string | null;
  url: string | null;
  /** Requested start offset for a later section of a long page. */
  offset: number | null;
  /** Canonical identity used for request history and repeat detection. */
  key: string;
};

function normaliseRequestUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * Canonical request identity.
 *
 * A page named by packet id and the same page named by URL are one request, not
 * two. Including the offset keeps a legitimate later-section request distinct.
 */
export function canonicalRequestKey(
  type: EvidenceRequest["requests"][number]["type"],
  target: string,
  opts: { pageId?: string | null; url?: string | null; offset?: number | null } = {}
): string {
  const offset = opts.offset != null ? `#offset=${opts.offset}` : "";
  if (opts.pageId) return `${type}|page:${opts.pageId}${offset}`;
  if (opts.url) return `${type}|url:${normaliseRequestUrl(opts.url)}${offset}`;
  const raw = target.startsWith("page:http") ? target.slice("page:".length) : target;
  if (type === "source_text") return `${type}|${raw.trim().toLowerCase()}${offset}`;
  if (type === "inventory_search") {
    const terms = [...new Set(raw.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3))].sort();
    return `${type}|${terms.join("+")}`;
  }
  if (raw.startsWith("http")) return `${type}|url:${normaliseRequestUrl(raw)}${offset}`;
  return `${type}|${raw.trim().toLowerCase()}${offset}`;
}

export const DEPENDENCY_MANIFEST_VERSION = "dependency-manifest/1";

export type DependencyManifest = {
  version: typeof DEPENDENCY_MANIFEST_VERSION;
  finalPacketHash: string;
  businessKnowledge: {
    documentRevision: number | null;
    factsHash: string;
  };
  pages: Array<{
    url: string;
    contentHash: string | null;
    retrieval: string;
    truncated: boolean;
    offset: number;
  }>;
  sources: Array<{
    id: string;
    url: string;
    excerptHash: string | null;
    observedAt: string;
  }>;
  searchIds: string[];
};

/**
 * The exact external inputs a decision depended on.
 *
 * Reuse is only safe when this manifest still matches current versioned storage
 * (or, for live pages inside the freshness window, the archived retrieval).
 */
export function buildDependencyManifest(packet: EvidencePacket): DependencyManifest {
  return {
    version: DEPENDENCY_MANIFEST_VERSION,
    finalPacketHash: packet.packetHash,
    businessKnowledge: {
      documentRevision: packet.businessFacts.reduce<number | null>(
        (max, fact) => (fact.documentRevision == null ? max : Math.max(max ?? 0, fact.documentRevision)),
        null
      ),
      factsHash: hashValue(packet.businessFacts.map((fact) => ({ id: fact.id, value: fact.value, revision: fact.documentRevision }))),
    },
    pages: packet.pages.map((page) => ({
      url: page.url,
      contentHash: page.contentHash,
      retrieval: page.retrieval,
      truncated: page.truncated,
      offset: page.offset ?? 0,
    })),
    sources: packet.sources.map((source) => ({
      id: source.id,
      url: source.url,
      excerptHash: source.excerpt ? hashValue(source.excerpt) : null,
      observedAt: source.observedAt,
    })),
    searchIds: packet.search.map((row) => row.id),
  };
}

export function parsePersistedDependencyManifest(value: unknown): DependencyManifest | null {
  if (typeof value === "string") {
    try {
      return parsePersistedDependencyManifest(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.version !== DEPENDENCY_MANIFEST_VERSION || typeof row.finalPacketHash !== "string") return null;
  if (!row.businessKnowledge || typeof row.businessKnowledge !== "object") return null;
  if (!Array.isArray(row.pages) || !Array.isArray(row.sources) || !Array.isArray(row.searchIds)) return null;
  return value as DependencyManifest;
}

export type AssessmentAttempt = {
  round: number;
  attempt: number;
  inputPacketHash: string;
  feedback: string | null;
  kind: "transport_error" | "invalid_output" | "validation_error" | "request_evidence" | "final_decision";
  raw: unknown;
  responseText: string | null;
  errors: string[];
};

/**
 * Check a request against the packet and the site scope.
 *
 * A request may name an existing packet item or a URL on the site's own domain.
 * It may not smuggle in another tenant or an arbitrary external origin. Discovery
 * searches only the known inventory; no new web crawl is implied.
 */
export function validateEvidenceRequest(
  request: EvidenceRequest,
  packet: EvidencePacket,
  opts: { siteDomain: string; maxRequests?: number; inventoryRows?: InventorySearchRow[] }
): EvidenceRequestValidation {
  const errors: string[] = [];
  const resolved: ResolvedEvidenceRequest[] = [];
  const max = Math.max(1, Math.min(opts.maxRequests ?? 4, 6));
  if (request.requests.length > max) errors.push(`request_evidence: at most ${max} requests are allowed per round`);
  const pages = new Map(packet.pages.map((page) => [page.id, page]));
  const pagesByUrl = new Map(packet.pages.map((page) => [page.url, page]));
  const sources = new Map(packet.sources.map((source) => [source.id, source]));
  const inventory = new Set(packet.inventory.map((row) => row.url));
  const domain = opts.siteDomain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();

  const terminal = new Map<string, { status: string; offset?: number }>();
  for (const row of packet.requests) {
    const key = row.key ?? canonicalRequestKey(row.type, row.target, { offset: row.offset });
    terminal.set(key, { status: row.status, offset: row.offset });
  }

  const rejectRepeat = (key: string, label: string): boolean => {
    const previous = terminal.get(key);
    if (!previous) return false;
    if (previous.status === "partial") return false;
    errors.push(
      `request ${label} was already attempted and is ${previous.status}; use the supplied evidence, request a later section, or return a final decision`
    );
    return true;
  };

  for (const entry of request.requests) {
    const offset = entry.offset ?? null;
    if (entry.type === "page_text") {
      // Models sometimes write page:<url> instead of the packet's page:<hash>.
      // That is a naming variant of the same site page, not a different origin.
      const target = entry.target.startsWith("page:http") ? entry.target.slice("page:".length) : entry.target;
      const page = pages.get(target) ?? pagesByUrl.get(target);
      if (page) {
        if (offset != null && page.totalChars > 0 && offset >= page.totalChars) {
          errors.push(`request for ${page.url} starts at offset ${offset}, beyond the known ${page.totalChars} characters`);
          continue;
        }
        if (offset == null && page.retrieval !== "unavailable" && page.text.trim() && !page.truncated) {
          errors.push(`request for ${page.url} asks for text that was already supplied in full`);
          continue;
        }
        // Canonicalise by URL so a page named by id and the same page named by
        // URL are one request, both before and after the page enters the packet.
        const key = canonicalRequestKey("page_text", entry.target, { url: page.url, offset });
        if (rejectRepeat(key, `${entry.type} ${page.url}`)) continue;
        resolved.push({ type: entry.type, target: entry.target, pageId: page.id, url: page.url, offset, key });
        continue;
      }
      let url: URL | null = null;
      try {
        url = new URL(target);
      } catch {
        url = null;
      }
      if (!url) {
        errors.push(`page_text target "${entry.target}" is neither a supplied page id nor a URL`);
        continue;
      }
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) {
        errors.push(`page_text target ${entry.target} is outside the site domain`);
        continue;
      }
      const key = canonicalRequestKey("page_text", entry.target, { url: url.toString(), offset });
      if (rejectRepeat(key, `page_text ${entry.target}`)) continue;
      resolved.push({ type: entry.type, target: entry.target, pageId: null, url: url.toString(), offset, key });
      continue;
    }
    if (entry.type === "source_text") {
      const source = sources.get(entry.target);
      if (!source) {
        errors.push(`source_text target "${entry.target}" is not in the packet`);
        continue;
      }
      const key = canonicalRequestKey("source_text", entry.target, { offset });
      if (rejectRepeat(key, `source_text ${entry.target}`)) continue;
      resolved.push({ type: entry.type, target: entry.target, pageId: null, url: source.url, offset, key });
      continue;
    }
    if (entry.type === "journey_links") {
      const target = entry.target.startsWith("page:http") ? entry.target.slice("page:".length) : entry.target;
      const page = pages.get(target) ?? pagesByUrl.get(target);
      if (page) {
        const key = canonicalRequestKey("journey_links", entry.target, { pageId: page.id });
        if (rejectRepeat(key, `journey_links ${page.url}`)) continue;
        resolved.push({ type: entry.type, target: entry.target, pageId: page.id, url: page.url, offset: null, key });
        continue;
      }
      // A known inventory URL may be inspected for links even when its text was
      // not in the initial selection. The service fetches it before reading links.
      if (inventory.has(target)) {
        const key = canonicalRequestKey("journey_links", entry.target, { url: target });
        if (rejectRepeat(key, `journey_links ${target}`)) continue;
        resolved.push({ type: entry.type, target: entry.target, pageId: null, url: target, offset: null, key });
        continue;
      }
      errors.push(`journey_links target "${entry.target}" is neither a supplied page nor a known inventory URL`);
      continue;
    }
    // inventory_search
    const terms = entry.target.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3);
    if (terms.length === 0) {
      errors.push("inventory_search needs at least one word of three characters or more");
      continue;
    }
    const searchRows = opts.inventoryRows?.length
      ? opts.inventoryRows
      : [...inventory].map((url) => ({ url, title: null, contentText: null }));
    const scored = searchRows
      .map((row) => {
        const haystack = `${row.url} ${row.title ?? ""} ${(row.contentText ?? "").slice(0, 8_000)}`
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { url: row.url, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.url.length - b.url.length);
    if (scored.length === 0) {
      errors.push(`inventory_search "${entry.target}" found no known page; absence in the known inventory is not proof of absence`);
      continue;
    }
    const key = canonicalRequestKey("inventory_search", entry.target, { url: scored[0].url });
    if (rejectRepeat(key, `inventory_search ${entry.target}`)) continue;
    resolved.push({ type: entry.type, target: entry.target, pageId: null, url: scored[0].url, offset: null, key });
  }
  return { ok: errors.length === 0, errors, resolved };
}

export function finaliseDecision(input: {
  model: ModelDecision;
  packet: EvidencePacket;
  modelName: string;
  promptVersion: string;
  now?: Date;
}): RecommendationDecision {
  // Identity and versions only. Coverage, targets, readiness and every other
  // semantic field are exactly what the model authored.
  const decision: RecommendationDecision = {
    ...input.model,
    schemaVersion: RECOMMENDATION_DECISION_VERSION,
    decisionId: `decision-${randomUUID()}`,
    candidateId: input.packet.candidate.findingId,
    dedupKey: input.packet.candidate.dedupKey,
    packetId: input.packet.packetId,
    packetHash: input.packet.packetHash,
    policyVersion: input.packet.policyVersion,
    promptVersion: input.promptVersion,
    model: input.modelName,
    assessedAt: (input.now ?? new Date()).toISOString(),
    inputLimitations: input.packet.limitations,
  };
  return decision;
}

export function parsePersistedPacket(value: unknown): EvidencePacket | null {
  if (typeof value === "string") {
    try {
      return parsePersistedPacket(JSON.parse(value));
    } catch {
      return null;
    }
  }
  const parsed = EvidencePacketSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parsePersistedDecision(value: unknown): RecommendationDecision | null {
  if (typeof value === "string") {
    try {
      return parsePersistedDecision(JSON.parse(value));
    } catch {
      return null;
    }
  }
  const parsed = RecommendationDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function decisionFingerprint(input: {
  packetHash: string;
  policyVersion: string;
  promptVersion: string;
  model: string;
}): string {
  return hashValue(input);
}
