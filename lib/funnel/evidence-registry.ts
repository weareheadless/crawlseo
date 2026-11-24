import type { EvidenceRecordKind } from "@prisma/client";

/**
 * CMP-011: what each evidence kind *is*, so a kind cannot silently rot.
 *
 * The defect this replaces: `EVIDENCE_KINDS` was a bare string array. It declared
 * nineteen names and nothing about them — not what they must contain, not who
 * writes them, not whether what they describe is a single sample or a rolling
 * window. A detector could therefore be built against a metric label, a dimension
 * or a whole kind that nothing produces, and the build stayed green. Measured on
 * 2026-11-24, eight of nineteen kinds had a broken producer/consumer pairing.
 *
 * Reading this table:
 *  - `producers` names the modules that may write the kind. An empty list is
 *    allowed only with a `reason`, and it means "declared but not yet collected".
 *  - `dimensions.required` is what a row cannot mean anything without.
 *    `optional` is everything else seen in production; a key outside both is a
 *    typo and is rejected at write time.
 *  - `metrics` lists the labels a writer may store. A label outside it (or a
 *    misspelled one) is rejected at write time, which is the failure this issue
 *    exists to prevent.
 *  - `window` is how to read the kind: `single_point` (latest observation),
 *    `rolling_window` (a period with its own previous counterpart), or
 *    `sampled_point` (a moment whose value is not a moving average).
 *
 * Nothing here encodes a tenant, a domain or a market: a kind is a shape.
 */

export type EvidenceWindow = "single_point" | "rolling_window" | "sampled_point";

export type EvidenceKindSpec = {
  /** Modules allowed to write this kind. Empty means nothing writes it yet. */
  producers: readonly string[];
  /** Why an empty producer list is acceptable. Required when `producers` is empty. */
  reason?: string;
  dimensions: {
    required: readonly string[];
    optional: readonly string[];
  };
  metrics: readonly string[];
  window: EvidenceWindow;
};

/**
 * The registry. Every kind the schema allows must appear here, and
 * `tests/evidence-contract.test.ts` fails when the two disagree.
 */
export const EVIDENCE_REGISTRY: Record<EvidenceRecordKind, EvidenceKindSpec> = {
  keyword_rank: {
    producers: ["lib/funnel/backfill", "lib/google/gsc-client"],
    dimensions: {
      required: ["query"],
      // `url` is present when the rank belongs to a page; a query-level average
      // has none. `windowRole` and `windowEnd` are the rolling-window identity.
      optional: ["url", "cluster", "windowEnd", "windowStart", "windowRole", "windowDays", "scope", "observations", "segments", "device", "locale"],
    },
    metrics: ["provider:position", "first_party:position", "first_party:impressions", "first_party:clicks", "first_party:ctr"],
    window: "rolling_window",
  },
  keyword_metrics: {
    producers: ["lib/dataforseo/collection", "lib/dataforseo/seo-research-evidence", "lib/research/monthly-bundle"],
    dimensions: {
      required: ["query"],
      optional: ["locale", "product", "seed", "derivedFrom", "sharedTokens", "specificity", "rowCount", "cluster"],
    },
    metrics: ["provider:volume", "provider:difficulty", "provider:cpc", "provider:competition", "provider:competitionLevel", "provider:topVolume"],
    window: "single_point",
  },
  serp_snapshot: {
    producers: ["lib/dataforseo/collection"],
    dimensions: {
      required: ["query"],
      // `competitorCovered` is absent when the SERP was unobserved, which is
      // deliberately not the same as "nobody covers it".
      optional: ["topUrl", "topDomains", "competitorCovered", "device", "locale"],
    },
    metrics: ["provider:position", "provider:organicResults"],
    window: "sampled_point",
  },
  serp_features: {
    producers: [],
    reason:
      "Declared for the SERP features the organic collector parses and then discards (local pack, PAA, related searches). Wiring them is the local-SEO plan, not this one.",
    dimensions: { required: ["query"], optional: ["type", "locale", "device"] },
    metrics: [],
    window: "sampled_point",
  },
  intent_label: {
    producers: [],
    reason: "Declared for a per-query intent label the taxonomy does not store yet; the model owns intent, and no writer exists.",
    dimensions: { required: ["query"], optional: ["locale"] },
    metrics: [],
    window: "single_point",
  },
  competitor_rank: {
    producers: ["lib/dataforseo/collection"],
    dimensions: {
      required: ["query", "domain"],
      // `cluster` is attached when the query has an accepted membership, so the
      // leaderboard can read one cluster without joining every membership. A query
      // with no membership is stored unclustered, never guessed.
      optional: ["url", "rankAbsolute", "device", "locale", "observedAt", "cluster"],
    },
    metrics: ["provider:position"],
    // Written per sampled SERP, not a rolling average.
    window: "sampled_point",
  },
  backlink_profile: {
    producers: ["lib/dataforseo/collection", "lib/funnel/link-gap-pass"],
    dimensions: {
      required: ["scope"],
      // O9 names the competitor whose referring domains are the gap, and the
      // cluster the query belongs to.
      //
      // CMP-007 adds three shapes under one kind, told apart by `scope`:
      //  - `own_domain`           the site's own backlink summary (existing),
      //  - `competitor`           one competitor's backlink summary,
      //  - `competitor_referring_domains` one referring set for one target.
      // `domains` is the set the gap is computed over and `domainRanks` its
      // provider ranks, kept as parallel arrays so the dimensions stay scalars.
      optional: [
        "domain", "crawlId", "competitor", "cluster", "domains", "domainRanks",
        "targetDomainCount",
        // Which competitor profiles a gap row was computed against, so O9 cites both
        // sides of the subtraction rather than only our own profile.
        "competitorEvidenceIds",
      ],
    },
    metrics: [
      "provider:totalBacklinks",
      "provider:referringDomains",
      "provider:referringIps",
      "provider:dofollow",
      "provider:nofollow",
      "provider:referringDomainGap",
      "provider:targetDomainCount",
    ],
    // A profile is one reading of a target at one moment; two months are two
    // measurements, not a re-statement.
    window: "single_point",
  },
  share_of_voice: {
    producers: [],
    reason: "Declared for CMP-008's measured visibility score; computed from competitor_rank and serp_snapshot, not collected directly.",
    dimensions: { required: ["cluster"], optional: ["locale", "windowStart", "windowEnd"] },
    metrics: [],
    window: "rolling_window",
  },
  keyword_universe_membership: {
    producers: ["lib/research/topic-map", "lib/funnel/cluster-discovery", "lib/funnel/tracked-grid"],
    dimensions: {
      required: ["query", "cluster"],
      // `grid: "tracked"` is CMP-004's declaration that this membership is part of
      // its cluster's tracked grid. It lives on the membership because the issue
      // forbids a second membership table and a duplicate flag on the query row.
      optional: ["source", "topic", "grid"],
    },
    // The topic map stores the membership's demand with the membership, derived
    // from first-party rows it read rather than collected for this record.
    metrics: ["derived:impressions", "derived:clicks", "derived:position", "derived:volume"],
    window: "single_point",
  },
  onpage_crawl: {
    producers: ["lib/dataforseo/onpage-adapter", "lib/funnel/backfill", "lib/crawler/engine"],
    dimensions: {
      required: ["url"],
      // O6 reads the fact-mismatch verdict off the crawl row, and it needs the
      // question and field the verdict is about.
      optional: [
        "impact", "severity", "issueType", "schemaType", "statusCode", "schemaMissing", "crawlId",
        "factMismatch", "question", "field",
        // Page identity, written by the onpage adapter.
        "title", "canonical", "wordCount", "h1Count", "internalLinks", "providerCheck",
      ],
    },
    // The adapter's own page score, alongside the issue count the detectors read.
    metrics: ["first_party:issueCount", "provider:issueCount", "first_party:responseTimeMs", "provider:onpageScore", "provider:loadMs"],
    window: "single_point",
  },
  internal_link_graph: {
    producers: ["lib/dataforseo/onpage-adapter"],
    dimensions: { required: ["url"], optional: ["target", "crawlId"] },
    metrics: [],
    window: "single_point",
  },
  ai_visibility_observation: {
    producers: ["lib/dataforseo/google-ai-overview-collection", "lib/dataforseo/ai-visibility-adapter"],
    dimensions: {
      required: ["question"],
      optional: ["model", "locale", "dataset", "surface", "answered", "rawExportReference", "device"],
    },
    metrics: ["provider:samples", "provider:citedCount", "provider:denominator", "provider:competitorCitedCount", "provider:brandPresent", "provider:askCount"],
    window: "sampled_point",
  },
  gsc_query: {
    producers: [],
    reason: "Declared for query-level Search Console rows; the GSC sync writes gsc_page today, so nothing writes this yet.",
    dimensions: { required: ["query"], optional: ["windowDays", "locale"] },
    metrics: [],
    window: "rolling_window",
  },
  gsc_page: {
    producers: ["lib/google/gsc-client"],
    dimensions: { required: ["url"], optional: ["windowDays", "query"] },
    metrics: ["first_party:position", "first_party:impressions", "first_party:clicks", "first_party:ctr"],
    window: "rolling_window",
  },
  vitals: {
    producers: [],
    reason:
      "O12 reads first_party:lcpSeconds and nothing writes the kind; VitalsReport holds the measurements in its own table. Projecting them is CMP-011's follow-up wiring, not its scope.",
    dimensions: { required: ["url"], optional: ["device", "date"] },
    metrics: ["first_party:lcpSeconds", "first_party:cls", "first_party:inp", "first_party:ttfb", "first_party:perfScore"],
    window: "single_point",
  },
  analytics: {
    producers: ["lib/dataforseo/seo-research-evidence"],
    dimensions: { required: ["scope"], optional: ["locale", "period"] },
    metrics: ["provider:organicKeywords", "provider:organicTraffic", "provider:organicCost", "provider:backlinks", "provider:referringDomains"],
    window: "single_point",
  },
  knowledge_fact: {
    producers: ["lib/projects/business-knowledge-evidence", "lib/research/weekly-refresh"],
    dimensions: {
      required: ["field"],
      optional: ["value", "question", "provenanceKind", "publicationUse", "provenanceStatus"],
    },
    metrics: [],
    window: "single_point",
  },
  question_coverage: {
    producers: ["lib/research/question-coverage-evidence"],
    dimensions: { required: ["question"], optional: ["intent", "observed", "questionId"] },
    metrics: [],
    window: "single_point",
  },
  research_finding: {
    producers: ["lib/recommendation/run", "lib/research/finding-evidence", "lib/research/reassess-findings"],
    dimensions: {
      required: ["findingId"],
      // A finding can be a business pain point or a search finding; the rest are
      // the recommendation packet it may carry.
      optional: [
        "runId", "theme", "urgency", "painPoint", "sentiment", "gapSummary", "findingType", "positioningGap",
        "painPointSummary", "query", "title", "coveragePage", "verification", "coverageState", "coverageComplete",
        "verificationReason", "recommendationError", "recommendationOutcome", "recommendationDedupKey",
        "recommendationPacketHash", "recommendationPacketJson", "recommendationAnalysisJson",
        "recommendationAttemptsJson", "recommendationRequestsJson", "recommendationFinalPacketJson",
        "recommendationDependenciesJson", "recommendationInitialPacketHash", "recommendationModel",
        "recommendationVersion", "recommendationFingerprint", "recommendationDecisionJson",
        "recommendationPromptVersion", "sourceUrl", "demandQueries",
      ],
    },
    metrics: ["first_party:confidence"],
    window: "single_point",
  },
};

/** Derived, so a consumer iterating kinds never changes. */
export const EVIDENCE_KINDS: readonly EvidenceRecordKind[] = Object.keys(EVIDENCE_REGISTRY) as EvidenceRecordKind[];

/** Every metric label any kind may store, for the contract test. */
export function declaredMetricLabels(): Set<string> {
  return new Set(Object.values(EVIDENCE_REGISTRY).flatMap((spec) => spec.metrics));
}

/** Metric labels a detector or view reads, by kind, for the contract test. */
export function kindAcceptsMetric(kind: EvidenceRecordKind, label: string): boolean {
  return EVIDENCE_REGISTRY[kind]?.metrics.includes(label) ?? false;
}
