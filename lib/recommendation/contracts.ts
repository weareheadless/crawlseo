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

export const EVIDENCE_PACKET_VERSION = "evidence-packet/1";
export const RECOMMENDATION_DECISION_VERSION = "recommendation-decision/1";
export const RECOMMENDATION_POLICY_VERSION = "recommendation-policy/1";

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
  retrieval: z.enum(["stored", "live", "unavailable"]),
  status: z.number().int(),
  language: z.string().nullable(),
  sections: z.array(z.object({ id, locator: z.string().max(200), text: z.string() })).max(12),
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
  inventory: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullable(),
      status: z.number().int(),
      indexable: z.boolean(),
      retrieval: z.enum(["stored", "unavailable"]),
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
  rationale: longText,
  excerpts: z.array(z.string().max(1_200)).max(4),
  limitations: z.array(z.string().max(400)).max(4),
});

const InvestigationSchema = z.object({
  question: shortText,
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
  const { packetHash: _ignored, packetId: _packetId, generatedAt: _generatedAt, ...body } = packet;
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
  return EvidencePacketSchema.parse({ ...base, packetHash: hashPacket(base) });
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
    coverageByPage.set(entry.pageId, entry);
    if (entry.state === "answers" || entry.state === "partially_answers") {
      if (entry.excerpts.length === 0) errors.push(`coverage "${entry.state}" for ${page.url} has no verbatim excerpt`);
      for (const excerpt of entry.excerpts) {
        if (!pageTextContains(page, excerpt)) errors.push(`coverage excerpt for ${page.url} does not occur in the supplied text`);
      }
    }
    if (entry.state === "unassessable" && page.retrieval !== "unavailable" && !page.truncated) {
      errors.push(`coverage for ${page.url} is marked unassessable although text was supplied`);
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
    if (decision.change?.trim()) errors.push("an investigation must not carry an implementation change");
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
      if (decision.intervention === "update_page") {
        const coverage = coverageByPage.get(page.id);
        if (!coverage || (coverage.state !== "partially_answers" && coverage.state !== "does_not_answer")) {
          errors.push(`update_page target ${page.url} has no assessed inadequacy`);
        }
      }
    }
  }

  if (decision.intervention === "create_asset") {
    const answered = decision.coverage.some((entry) => entry.state === "answers" || entry.state === "partially_answers");
    const unassessable = decision.coverage.some((entry) => entry.state === "unassessable");
    if (answered) errors.push("create_asset cannot be justified when an existing page answers the question");
    if (unassessable) errors.push("create_asset cannot be justified while relevant page text is unassessable");
    if (decision.coverage.length === 0) errors.push("create_asset needs at least one assessed page that does not answer");
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

const ENUM_ALIASES: Record<string, Record<string, string>> = {
  readiness: {
    actionable_work: "actionable",
    action: "actionable",
    investigate: "needs_investigation",
    investigation: "needs_investigation",
    backlog: "research_backlog",
    no_change: "no_action",
    noaction: "no_action",
    maintain: "no_action",
    reject: "rejected",
    insufficient_evidence: "research_backlog",
    needs_more_evidence: "needs_investigation",
    partial: "needs_investigation",
  },
  intervention: {
    update: "update_page",
    update_existing: "update_page",
    create: "create_asset",
    new_asset: "create_asset",
    link: "improve_journey",
    linking: "improve_journey",
    no_change: "maintain",
    none: "maintain",
    investigate_more: "investigate",
  },
  evidenceState: {
    unknown: "unverified",
    not_assessed: "unverified",
    insufficient: "unverified",
    unsupported: "unverified",
    false: "contradicted",
    true: "supported",
    not_applicable: "unverified",
    "n/a": "unverified",
    partial: "unverified",
    mixed: "unverified",
    supported_with_caveats: "supported",
    contradicted_by_content: "contradicted",
  },
  coverageState: {
    answer: "answers",
    partial: "partially_answers",
    partial_answer: "partially_answers",
    does_not: "does_not_answer",
    no_answer: "does_not_answer",
    unknown: "unassessable",
    not_assessed: "unassessable",
    not_applicable: "unassessable",
    "n/a": "unassessable",
    mixed: "partially_answers",
  },
  targetRole: {
    update_page: "update",
    update_existing: "update",
    link: "link_to",
    internal_link: "link_to",
    new: "new_asset",
    create: "new_asset",
  },
  measurement: {
    none: "unquantified",
    unknown: "unquantified",
    not_measured: "unquantified",
    not_quantified: "unquantified",
    unmeasured: "unquantified",
    qualitative: "unquantified",
    no_data: "unquantified",
    estimated: "forecast",
    estimate: "forecast",
    scenario: "forecast",
    measured: "observed_baseline",
    measured_baseline: "observed_baseline",
    baseline: "observed_baseline",
  },
  reviewRequirement: {
    expert: "subject_matter_expert",
    sme: "subject_matter_expert",
    legal_review: "legal",
    medical_review: "medical",
    technical_review: "technical",
  },
  instrumentation: {
    yes: "available",
    no: "unavailable",
    unknown: "unknown",
  },
};

function alias(value: unknown, group: keyof typeof ENUM_ALIASES): unknown {
  if (typeof value !== "string") return value;
  return ENUM_ALIASES[group][value.toLowerCase()] ?? value;
}

/**
 * Map common model vocabulary to the contract's enums before schema validation.
 *
 * This is vocabulary compatibility, not a change of meaning: the decision still
 * has to satisfy the same integrity checks.
 */
export function normaliseModelDecision(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const row = structuredClone(raw) as Record<string, any>;
  if (row.readiness) row.readiness = alias(row.readiness, "readiness");
  if (row.intervention) row.intervention = alias(row.intervention, "intervention");
  for (const key of ["question", "premise", "offerFit"]) {
    if (row[key]?.state) row[key].state = alias(row[key].state, "evidenceState");
  }
  if (Array.isArray(row.coverage)) {
    for (const entry of row.coverage) {
      if (entry?.state) entry.state = alias(entry.state, "coverageState");
    }
  }
  if (Array.isArray(row.targets)) {
    const fallbackRole =
      row.intervention === "improve_journey" ? "link_to" : row.intervention === "create_asset" ? "new_asset" : "update";
    for (const target of row.targets) {
      if (!target) continue;
      const mapped = target.role ? alias(target.role, "targetRole") : fallbackRole;
      target.role = TARGET_ROLES.includes(mapped as never) ? mapped : fallbackRole;
    }
  }
  if (Array.isArray(row.benefits)) {
    for (const benefit of row.benefits) {
      if (benefit?.measurement) benefit.measurement = alias(benefit.measurement, "measurement");
    }
  }
  if (Array.isArray(row.reviews)) {
    for (const review of row.reviews) {
      if (review?.requirement) review.requirement = alias(review.requirement, "reviewRequirement");
    }
  }
  if (row.success?.instrumentation) row.success.instrumentation = alias(row.success.instrumentation, "instrumentation");
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

export function finaliseDecision(input: {
  model: ModelDecision;
  packet: EvidencePacket;
  modelName: string;
  promptVersion: string;
  now?: Date;
}): RecommendationDecision {
  // Models sometimes emit two coverage rows for the same page. Keep the checked
  // positive row when present, otherwise the first; this is structural cleanup,
  // not a change to the assessment.
  const byPage = new Map<string, ModelDecision["coverage"][number]>();
  for (const entry of input.model.coverage) {
    const previous = byPage.get(entry.pageId);
    if (!previous) {
      byPage.set(entry.pageId, entry);
      continue;
    }
    const positive = entry.state === "answers" || entry.state === "partially_answers";
    if (positive && entry.excerpts.length > 0) byPage.set(entry.pageId, entry);
  }
  const decision: RecommendationDecision = {
    ...input.model,
    coverage: [...byPage.values()],
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
