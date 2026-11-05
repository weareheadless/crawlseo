import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { upsertOpportunity, type OpportunityDb } from "@/lib/funnel/opportunity";
import { assignQuery, type TopicCluster, type TopicMap } from "@/lib/research/topic-map";
import { taxonomyForDomain } from "@/lib/research/topic-taxonomy";

/**
 * Phase 3: turn the reviewed topic map into board-ready proposals.
 *
 * The deterministic templates come from the topic map's own gaps: a missing
 * service page, a thin category page, a product-range question, a local gap, a
 * measured AEO citation gap and a timely news item. The optional AI critique
 * can drop or challenge a proposal; it cannot invent queries, pages or evidence.
 *
 * Proposals are stored in the existing `Opportunity` table. The minimal contract
 * lives in `recommendationDecision`; no new table, no task, no acceptance.
 */

export type ProposalLane = "timely" | "content_business" | "aeo_geo" | "technical";
export type ProposalKind = "article" | "update" | "cluster_hub" | "business" | "aeo" | "technical";
export type ProposalEffort = "small" | "medium" | "large" | "unknown";
export type ProposalConfidence = "high" | "medium" | "low";

export type ProposalTarget = {
  url: string | null;
  newAsset: boolean;
  section: string | null;
};

export type Proposal = {
  dedupKey: string;
  lane: ProposalLane;
  kind: ProposalKind;
  title: string;
  summary: string;
  whyNow: string | null;
  evidenceRefs: string[];
  target: ProposalTarget;
  action: string;
  expectedOutcome: string;
  effort: ProposalEffort;
  confidence: ProposalConfidence;
  expiresAt: string | null;
  topicSlug: string | null;
  sources: Array<{ title: string; url: string; publishedAt: string | null }>;
  critique?: { verdict: "keep" | "revise" | "drop"; reason: string } | null;
};

export type ProposalGenerationDb = OpportunityDb &
  Pick<
    PrismaClient,
    | "site"
    | "researchRun"
    | "researchSource"
    | "demandMapCluster"
    | "evidenceRecord"
    | "opportunity"
  >;

export type ProposalInputs = {
  site: { id: string; domain: string; projectId: string };
  map: TopicMap;
  topicMapRunId: string;
  clusters: Array<{ id: string; slug: string }>;
  evidenceByCluster: Map<string, string[]>;
  knowledgeEvidenceIds: string[];
  aeoEvidence: Array<{ id: string; question: string; cited: number; competitorCited: number }>;
  news: Array<{ id: string; title: string; url: string; publishedAt: string | null; excerpt: string | null }>;
  technical: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    scoreValue: number | null;
  }>;
};

export type ProposalRunResult = {
  status: "planned" | "completed" | "existing";
  runId: string | null;
  proposals: Proposal[];
  dropped: Array<{ title: string; reason: string }>;
  critique: { available: boolean; model: string | null; summary: string | null; error: string | null };
  technical: ProposalInputs["technical"];
  counts: { proposals: number; byLane: Record<string, number>; dropped: number };
};

const TYPE_FOR_PROPOSAL: Record<string, "O3_content_gap" | "O4_aeo_citation_gap" | "O11_freshness_decay" | "O14_offer_positioning_gap"> = {
  "content_business:article": "O3_content_gap",
  "content_business:update": "O3_content_gap",
  "content_business:cluster_hub": "O3_content_gap",
  "content_business:business": "O14_offer_positioning_gap",
  "aeo_geo:aeo": "O4_aeo_citation_gap",
  "timely:article": "O11_freshness_decay",
  "timely:update": "O11_freshness_decay",
  "timely:business": "O14_offer_positioning_gap",
};

const DIMENSION_FOR_TYPE = {
  O3_content_gap: "content",
  O4_aeo_citation_gap: "aeo",
  O11_freshness_decay: "seo",
  O14_offer_positioning_gap: "content",
} as const;

export function proposalHash(proposal: Omit<Proposal, "dedupKey">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        lane: proposal.lane,
        kind: proposal.kind,
        target: proposal.target,
        action: proposal.action,
        title: proposal.title,
      })
    )
    .digest("hex")
    .slice(0, 16);
}

export function buildDeterministicProposals(inputs: ProposalInputs): Proposal[] {
  const proposals: Proposal[] = [];
  const clusterOf = (slug: string): TopicCluster | null =>
    inputs.map.clusters.find((cluster) => cluster.slug === slug) ?? null;
  const evidenceOf = (slug: string): string[] => inputs.evidenceByCluster.get(slug) ?? [];
  const knowledge = inputs.knowledgeEvidenceIds.slice(0, 2);

  const add = (proposal: Omit<Proposal, "dedupKey" | "evidenceRefs" | "sources"> & {
    evidenceRefs: string[];
    sources?: Proposal["sources"];
  }) => {
    // Stable identity: a wording change must update the same board row, not
    // create a second one. The fingerprint still records the exact version.
    const identity = JSON.stringify({
      lane: proposal.lane,
      kind: proposal.kind,
      topicSlug: proposal.topicSlug ?? null,
      target: proposal.target,
    });
    const dedupKey = `phase3:${proposal.lane}:${proposal.kind}:${proposal.topicSlug ?? "site"}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    proposals.push({
      ...proposal,
      dedupKey,
      evidenceRefs: [...new Set([...knowledge, ...proposal.evidenceRefs])].slice(0, 8),
      sources: proposal.sources ?? [],
    });
  };

  // 1. The clearest service gap: a blog post ranks, but there is no service page.
  const restoration = clusterOf("restauration-abat-jour");
  if (restoration) {
    add({
      lane: "content_business",
      kind: "article",
      title: "Créer une page service « Restauration d'abat-jour »",
      summary: `${restoration.metrics.queries} queries and ${restoration.metrics.impressions} impressions, with the site already around position ${restoration.metrics.position?.toFixed(1) ?? "?"}, but the only coverage is a blog post.`,
      whyNow: "The commercial queries already rank near page one; the missing service page is the gap between a blog visit and a quote request.",
      evidenceRefs: evidenceOf("restauration-abat-jour"),
      target: { url: "/restauration-abat-jour", newAsset: true, section: "service page" },
      action: "Create a dedicated service page covering repair, re-covering, lining and contrecollé work, with before/after examples, process, lead time, a quote CTA and links to the blog post and the abat-jour category.",
      expectedOutcome: "Capture the commercial restoration queries on a service page instead of a blog post and increase quote requests from abat-jour restoration.",
      effort: "medium",
      confidence: "high",
      expiresAt: null,
      topicSlug: "restauration-abat-jour",
    });
  }

  // 2. Thin category page against the head term.
  const creation = clusterOf("creation-abat-jour");
  if (creation) {
    add({
      lane: "content_business",
      kind: "update",
      title: "Enrichir la page catégorie Abat-jours",
      summary: `${creation.metrics.queries} queries and ${creation.metrics.volume} measured monthly volume, led by the head term, but /lampes/abat-jours is only 150 words.`,
      whyNow: "The category page is the natural landing page for the head term and the pagode/tambour queries; at 150 words it cannot answer shape, size or fabric questions.",
      evidenceRefs: evidenceOf("creation-abat-jour"),
      target: { url: "/lampes/abat-jours", newAsset: false, section: "category page" },
      action: "Expand the category page with a shape guide (pagode, tambour, empire, cone), size and fabric guidance, a collection comparison, FAQ and links to the product pages. Keep the existing products and add no new range.",
      expectedOutcome: "Improve relevance and internal linking for the abat-jour head term and the pagode/tambour long tail.",
      effort: "medium",
      confidence: "medium",
      expiresAt: null,
      topicSlug: "creation-abat-jour",
    });
  }

  // 3. Lighting hub and thin subcategories.
  const lighting = clusterOf("luminaires");
  if (lighting) {
    add({
      lane: "content_business",
      kind: "update",
      title: "Renforcer le hub luminaires et les sous-catégories",
      summary: `${lighting.metrics.queries} queries, ${lighting.metrics.impressions} impressions and ${lighting.metrics.volume} measured volume; the hub ranks, but the thin subcategory pages are not supporting the format queries. Market scope: ${lighting.marketScope.scope}${lighting.marketScope.markets.length ? ` (${lighting.marketScope.markets.join(", ")})` : ""}.`,
      whyNow: "The lighting range has the most first-party demand, and the thin subcategory pages cannot support the head and format queries.",
      evidenceRefs: evidenceOf("luminaires"),
      target: { url: "/lampes", newAsset: false, section: "hub and subcategories" },
      action: "Expand /lampes and the thin subcategory pages with buying guidance, format comparisons, room use, materials and internal links; add product schema where it is missing. If the owner wants to add formats, plan the range and pages.",
      expectedOutcome: "Improve rankings for luminaire artisanal and the subcategory queries, and send clearer traffic to the product pages.",
      effort: "medium",
      confidence: "medium",
      expiresAt: null,
      topicSlug: "luminaires",
    });

    add({
      lane: "content_business",
      kind: "business",
      title: "Opportunité gamme plafonniers / lustres / lampadaires",
      summary: `Queries for plafonnier, lustre and lampadaire have demand; no matching product page is visible in the current crawl. The configured market scope for this offer is ${lighting.marketScope.scope}${lighting.marketScope.markets.length ? ` (${lighting.marketScope.markets.join(", ")})` : ""}.`,
      whyNow: "The demand is already visible in Search Console; the owner can decide whether to add the formats, source a curated selection or leave the queries unserved.",
      evidenceRefs: evidenceOf("luminaires"),
      target: { url: null, newAsset: false, section: "product range opportunity" },
      action: "Evaluate adding plafonniers, lustres or lampadaires, or a curated selection. If the owner accepts, plan the product pages, collection copy and internal links. The owner decides; the system does not assume the range exists or does not exist.",
      expectedOutcome: "Give the owner a clear, demand-backed product opportunity without inventing a range or blocking the idea before they decide.",
      effort: "small",
      confidence: "high",
      expiresAt: null,
      topicSlug: "luminaires",
    });
  }

  // 4. Seating service page language and local proof.
  const seating = clusterOf("restauration-siege");
  if (seating) {
    add({
      lane: "content_business",
      kind: "update",
      title: "Renforcer la page restauration de sièges",
      summary: `${seating.metrics.queries} queries and ${seating.metrics.volume} measured volume; /tapisserie-restauration is strong, but the query language for tapissier and chaises is missing.`,
      whyNow: "The service page already ranks; adding the words customers use and local proof is a cheaper win than a new page.",
      evidenceRefs: evidenceOf("restauration-siege"),
      target: { url: "/tapisserie-restauration", newAsset: false, section: "service page" },
      action: "Add sections for tapissier, tapisserie traditionnelle, chaises and fauteuils, the restoration process, before/after proof, Normandy locations served and a clear quote CTA. Link the local workshop page.",
      expectedOutcome: "Capture more tapissier/chaise queries on the existing service page and improve local relevance.",
      effort: "medium",
      confidence: "high",
      expiresAt: null,
      topicSlug: "restauration-siege",
    });

    add({
      lane: "content_business",
      kind: "update",
      title: "Ajouter une preuve locale à la page restauration",
      summary: `Local queries exist around ${inputs.map.business.location ?? inputs.map.business.serviceArea[0] ?? "the service area"}, but no dedicated local landing page combines the trade and the place.`,
      whyNow: "A local landing page is a larger commitment; a local proof section on the service page tests the demand first.",
      evidenceRefs: evidenceOf("local-normandie"),
      target: { url: "/tapisserie-restauration", newAsset: false, section: "local proof" },
      action: `Add a local section naming ${inputs.map.business.location ?? inputs.map.business.serviceArea[0] ?? "the service area"}, the places served, workshop visits and nearby towns. Do not chase off-area queries unless the business decides to serve that market.`,
      expectedOutcome: "Test local intent without creating a thin local page; measure whether local queries and quote requests move.",
      effort: "small",
      confidence: "medium",
      expiresAt: null,
      topicSlug: "local-normandie",
    });
  }

  // 4b. Local expansion: low measured demand is not the same as no opportunity.
  const local = clusterOf("local-normandie");
  if (local) {
    add({
      lane: "content_business",
      kind: "cluster_hub",
      title: "Créer une page locale « Tapissier en Normandie »",
      summary: `${local.metrics.queries} local queries and ${local.metrics.impressions} impressions; measured demand is low, but local intent is business-relevant and there is no dedicated local page.`,
      whyNow: "Low measured volume is not the same as no opportunity: a local page gives the atelier a page to rank, link and cite for local intent.",
      evidenceRefs: evidenceOf("local-normandie"),
      target: { url: "/tapissier-normandie", newAsset: true, section: "local landing page" },
      action: "Create a local landing page for the upholstery/restoration service in the configured local market: services, places served, workshop visits, local proof, map and quote CTA; link it from the service page and the home page. If the owner prefers a smaller test, add a local proof section to /tapisserie-restauration first.",
      expectedOutcome: "A dedicated local page for tapissier-en-Normandie and autour-de-moi intent; measure impressions, quote requests and whether the local page earns links.",
      effort: "medium",
      confidence: "low",
      expiresAt: null,
      topicSlug: "local-normandie",
    });
  }

  // 5. Workshop page.
  const kits = clusterOf("kits-ateliers");
  if (kits) {
    add({
      lane: "content_business",
      kind: "update",
      title: "Compléter la page ateliers DIY",
      summary: `${kits.metrics.queries} queries and ${kits.metrics.impressions} impressions; the workshop page is strong but the kit product and the sessions are not fully connected.`,
      whyNow: "The query set is transactional and close to booking; the page should answer dates, level, materials and what participants take home.",
      evidenceRefs: evidenceOf("kits-ateliers"),
      target: { url: "/les-ateliers", newAsset: false, section: "workshop page" },
      action: "Add upcoming sessions, level, duration, materials, what is included, booking steps and a link to the DIY kit product. Add FAQ for the common questions.",
      expectedOutcome: "Turn workshop demand into bookings and connect the workshop page to the kit product.",
      effort: "small",
      confidence: "medium",
      expiresAt: null,
      topicSlug: "kits-ateliers",
    });
  }

  // 6. Measured AEO gap, split by the topic that owns the question.
  const taxonomy = taxonomyForDomain(inputs.site.domain);
  const aeoByTopic = new Map<string, typeof inputs.aeoEvidence>();
  for (const row of inputs.aeoEvidence) {
    const slug = assignQuery(row.question, taxonomy)[0]?.topic.slug;
    if (!slug || !clusterOf(slug)) continue;
    aeoByTopic.set(slug, [...(aeoByTopic.get(slug) ?? []), row]);
  }
  const aeoGroups = [...aeoByTopic.entries()]
    .filter(([slug, rows]) => {
      const cluster = clusterOf(slug);
      return Boolean(cluster && cluster.relevance !== "low" && rows.length >= 2);
    })
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3);
  for (const [slug, rows] of aeoGroups) {
    const cluster = clusterOf(slug);
    if (!cluster) continue;
    const cited = rows.reduce((sum, row) => sum + row.cited, 0);
    const newAsset = slug === "restauration-abat-jour";
    const target = newAsset ? "/restauration-abat-jour" : cluster.pages[0]?.url ?? "/";
    const formatDecision = rows.some((row) => /\b(plafonnier|lustre|lampadaire)\b/i.test(row.question));
    add({
      lane: "aeo_geo",
      kind: "aeo",
      title: `Ajouter des réponses citables — ${cluster.name}`,
      summary: `${rows.length} measured Google AI Overview question${rows.length === 1 ? "" : "s"}, ${cited} citation${cited === 1 ? "" : "s"} of the site; competitors are cited on the rest.`,
      whyNow: "These are measured answers, not question coverage: the site was asked and not cited.",
      evidenceRefs: rows.map((row) => row.id),
      target: { url: target, newAsset, section: "answer blocks and FAQ" },
      action: `Add concise, source-backed answer blocks to ${target} for: ${rows.slice(0, 5).map((row) => row.question).join("; ")}. Use definitions, process, materials, lead time and local proof, with headings and FAQ schema where appropriate.${newAsset ? " Add them to the new restoration service page; keep the blog post as the how-to." : ""}${formatDecision ? " If a question targets a format the atelier does not currently sell, treat it as a range decision for the owner; do not publish a product claim before that decision." : ""}`,
      expectedOutcome: `Increase the chance of being cited in Google AI Overviews for the ${cluster.name.toLowerCase()} questions and improve the supporting organic answer.`,
      effort: "medium",
      confidence: "medium",
      expiresAt: null,
      topicSlug: slug,
    });
  }

  // 7. Timely: only when the bundle has dated news.
  const timelyCutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
  const datedNews = inputs.news
    .filter((item) => item.publishedAt && Date.parse(item.publishedAt) >= timelyCutoff)
    .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""))
    .slice(0, 5);
  if (datedNews.length > 0) {
    const newest = datedNews[0];
    add({
      lane: "timely",
      kind: "article",
      title: "Capitaliser sur la presse locale autour de l'atelier",
      summary: `The bundle contains ${inputs.news.length} news/event sources, including “${newest.title}”.`,
      whyNow: `Local press is live${newest.publishedAt ? ` since ${newest.publishedAt.slice(0, 10)}` : ""}; a dated atelier story can be linked from the home page and the about page.`,
      evidenceRefs: evidenceOf("local-normandie"),
      target: { url: "/blog", newAsset: true, section: "news / press note" },
      action: "Write a short dated atelier note that responds to the local press coverage, links the original source, names the atelier and the Normandy location, and links to the restoration and workshop pages. Keep it factual and quote only what the source supports.",
      expectedOutcome: "Turn local press into a dated, linkable atelier story and a fresh signal for the local pages.",
      effort: "small",
      confidence: "low",
      expiresAt: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString(),
      topicSlug: "local-normandie",
      sources: datedNews.map((item) => ({ title: item.title, url: item.url, publishedAt: item.publishedAt })),
    });
  }

  return dedupeProposals(proposals);
}

export function dedupeProposals(proposals: Proposal[]): Proposal[] {
  const seen = new Set<string>();
  return proposals.filter((proposal) => {
    if (seen.has(proposal.dedupKey)) return false;
    seen.add(proposal.dedupKey);
    return true;
  });
}

export function validateProposal(
  proposal: Proposal,
  input: { domain: string; evidenceIds: Set<string> }
): string | null {
  if (!proposal.title.trim()) return "missing title";
  if (!proposal.summary.trim()) return "missing summary";
  if (!proposal.action.trim()) return "missing action";
  if (!proposal.expectedOutcome.trim()) return "missing expected outcome";
  if (!["timely", "content_business", "aeo_geo", "technical"].includes(proposal.lane)) return "invalid lane";
  if (!["article", "update", "cluster_hub", "business", "aeo", "technical"].includes(proposal.kind)) return "invalid kind";
  if (!["small", "medium", "large", "unknown"].includes(proposal.effort)) return "invalid effort";
  if (!["high", "medium", "low"].includes(proposal.confidence)) return "invalid confidence";
  if (proposal.evidenceRefs.length === 0) return "no evidence references";
  const missingEvidence = proposal.evidenceRefs.filter((id) => !input.evidenceIds.has(id));
  if (missingEvidence.length > 0) return `unknown evidence: ${missingEvidence.slice(0, 3).join(", ")}`;
  if (proposal.target.url) {
    try {
      const host = new URL(proposal.target.url, `https://${input.domain}`).hostname.replace(/^www\./, "");
      if (host !== input.domain.replace(/^www\./, "")) return "target is not on the site";
    } catch {
      return "invalid target URL";
    }
  } else if (!proposal.target.newAsset && proposal.kind !== "business" && proposal.kind !== "aeo") {
    return "article/update needs a target page or a new asset";
  }
  if (proposal.lane === "timely") {
    if (!proposal.whyNow) return "timely proposal needs whyNow";
    if (!proposal.expiresAt || Number.isNaN(Date.parse(proposal.expiresAt))) return "timely proposal needs a valid expiry";
    if (Date.parse(proposal.expiresAt) <= Date.now()) return "timely proposal expiry is in the past";
  }
  return null;
}

export function proposalScoreInputs(
  proposal: Proposal,
  cluster: TopicCluster | null
): {
  worth: Record<string, unknown>;
  winProbability: Record<string, number>;
  effort: { playTypeBase: number; sizeFactor: number };
  freshness: number;
  stability: number;
} {
  const volume = cluster?.metrics.volume || cluster?.metrics.impressions || null;
  const businessValue = cluster?.relevance === "high" ? 0.85 : cluster?.relevance === "medium" ? 0.55 : 0.25;
  const sizeFactor = proposal.effort === "small" ? 0.5 : proposal.effort === "large" ? 2 : 1;
  return {
    worth: {
      volume,
      ctrAtPosition: volume ? 0.03 : null,
      businessValue,
      volumeSource: cluster?.metrics.volume ? "provider" : volume ? "first_party" : "unknown",
      readiness: proposal.kind === "business" ? "needs_investigation" : "actionable",
      measurement: proposal.kind === "business" ? "unquantified" : volume ? "observed_baseline" : "unquantified",
      benefitTrack: proposal.lane === "technical" ? "technical_health" : "organic_growth",
      intervention:
        proposal.kind === "business"
          ? "investigate"
          : proposal.kind === "update"
            ? "update_page"
            : proposal.kind === "article"
              ? "create_asset"
              : "improve_journey",
      change: proposal.action,
      successMeasure: proposal.expectedOutcome,
      targetPages: proposal.target.url ? [proposal.target.url] : [],
      coverageSummary: cluster ? `Topic coverage: ${cluster.coverage}` : null,
      needRationale: proposal.summary,
      offerFitRationale: cluster?.rationale ?? null,
      targetPosition: null,
      currentPosition: cluster?.metrics.position ?? null,
      windowDays: null,
      observedImpressions: cluster?.metrics.impressions ?? null,
      technical: false,
      unmeasured: !volume,
    },
    winProbability: {
      rankDistance: 0.5,
      authorityGap: 0.5,
      pageStrength: 0.5,
      serpCompetition: 0.5,
      playTypeFactor: 0.6,
    },
    effort: { playTypeBase: 8, sizeFactor },
    freshness: 0.9,
    stability: 0.8,
  };
}

function deterministicCritique(proposals: Proposal[]): {
  available: boolean;
  model: string | null;
  summary: string | null;
  error: string | null;
  decisions: Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>;
} {
  const decisions = new Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>();
  const byTarget = new Map<string, Proposal[]>();
  for (const proposal of proposals) {
    if (!proposal.target.url) continue;
    byTarget.set(proposal.target.url, [...(byTarget.get(proposal.target.url) ?? []), proposal]);
  }
  let overlaps = 0;
  for (const [url, group] of byTarget) {
    if (group.length <= 1) continue;
    overlaps += 1;
    for (const proposal of group.slice(1)) {
      decisions.set(proposal.dedupKey, {
        verdict: "revise",
        reason: `Same target (${url}) as “${group[0].title}”; sequence or merge before accepting.`,
      });
    }
  }
  let dependencies = 0;
  for (const proposal of proposals) {
    if (!proposal.target.newAsset || !proposal.target.url) continue;
    // The proposal that creates the page is not dependent on itself. Other
    // proposals aimed at the same new URL are.
    const creator = proposals.find(
      (other) =>
        other.target.newAsset &&
        other.target.url === proposal.target.url &&
        (other.kind === "article" || other.kind === "cluster_hub")
    );
    if (creator && creator !== proposal) {
      dependencies += 1;
      decisions.set(proposal.dedupKey, {
        verdict: "revise",
        reason: `Depends on the new asset at ${proposal.target.url}; sequence after “${creator.title}”.`,
      });
    }
  }
  let thin = 0;
  for (const proposal of proposals) {
    if (proposal.evidenceRefs.length >= 2) continue;
    thin += 1;
    decisions.set(proposal.dedupKey, {
      verdict: "revise",
      reason: "Thin evidence: fewer than two evidence references.",
    });
  }
  return {
    available: true,
    model: "deterministic",
    summary: `Deterministic critique: ${proposals.length} proposals checked; ${overlaps} target overlap(s), ${dependencies} new-asset dependency, ${thin} thin-evidence item(s).`,
    error: null,
    decisions,
  };
}

export async function critiqueProposals(
  proposals: Proposal[],
  map: TopicMap
): Promise<{
  available: boolean;
  model: string | null;
  summary: string | null;
  error: string | null;
  decisions: Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>;
}> {
  const config = contentWriterConfig();
  if (!config) {
    return { available: false, model: null, summary: null, error: "CONTENT_LLM_API_KEY is not configured", decisions: new Map() };
  }
  if (proposals.length === 0) {
    return { available: false, model: config.model, summary: null, error: "no proposals to critique", decisions: new Map() };
  }
  const payload = {
    site: map.domain,
    proposals: proposals.map((proposal) => ({
      dedupKey: proposal.dedupKey,
      lane: proposal.lane,
      kind: proposal.kind,
      title: proposal.title.slice(0, 180),
      summary: proposal.summary.slice(0, 300),
      target: proposal.target,
      action: proposal.action.slice(0, 400),
      evidenceCount: proposal.evidenceRefs.length,
    })),
  };
  const system = [
    "You are an SEO critic for a small craft business.",
    "Check each proposal for unsupported claims, duplicates and wrong target pages.",
    "Respect the tenant market scope: a local service is local, while a national or international product offer may be proposed beyond the local service area. The owner decides whether to add a product range.",
    "A low-demand but business-relevant local proposal is valid; do not drop it only because volume is low. Check whether it is a reasonable expansion or small test.",
    "Do not rewrite the proposals. Return exactly one JSON object: { summary: string, decisions: [{ dedupKey: string, verdict: 'keep'|'revise'|'drop', reason: string }] }.",
    "Use only the supplied dedupKeys. Keep the summary under 300 characters and each reason under 200 characters.",
  ].join("\n");

  try {
    const parsed = await chatJson({
      config,
      system,
      user: JSON.stringify(payload),
      maxTokens: 12_000,
      temperature: 0.2,
      attempts: 2,
      timeoutMs: 120_000,
      // Reasoning models can spend a small completion budget before emitting
      // content; keep enough room for both the reasoning and the JSON answer.
      jsonMode: false,
    });
    const record = asRecord(parsed);
    const decisions = new Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>();
    for (const raw of Array.isArray(record.decisions) ? record.decisions : []) {
      const row = asRecord(raw);
      const dedupKey = textValue(row.dedupKey);
      const verdict = textValue(row.verdict);
      const reason = textValue(row.reason);
      if (!dedupKey || !verdict || !["keep", "revise", "drop"].includes(verdict)) continue;
      decisions.set(dedupKey, { verdict: verdict as "keep" | "revise" | "drop", reason: reason?.slice(0, 400) ?? "" });
    }
    return {
      available: true,
      model: config.model,
      summary: textValue(record.summary)?.slice(0, 800) ?? null,
      error: null,
      decisions,
    };
  } catch (error) {
    const fallback = deterministicCritique(proposals);
    return {
      ...fallback,
      error: `AI critique unavailable: ${
        error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400)
      }. Deterministic checks used.`,
    };
  }
}

export async function storeProposals(
  db: ProposalGenerationDb,
  input: {
    projectId: string;
    siteId: string;
    domain: string;
    map: TopicMap;
    topicMapRunId: string;
    proposals: Proposal[];
    evidenceIds: Set<string>;
    knowledgeEvidenceIds: string[];
    clusters: Array<{ id: string; slug: string }>;
  }
): Promise<{ stored: Array<{ id: string; dedupKey: string }>; dropped: Array<{ title: string; reason: string }> }> {
  const stored: Array<{ id: string; dedupKey: string }> = [];
  const dropped: Array<{ title: string; reason: string }> = [];
  const clusterIdBySlug = new Map(input.clusters.map((cluster) => [cluster.slug, cluster.id]));

  for (const proposal of input.proposals) {
    const invalid = validateProposal(proposal, { domain: input.domain, evidenceIds: input.evidenceIds });
    if (invalid) {
      dropped.push({ title: proposal.title, reason: invalid });
      continue;
    }
    const type = TYPE_FOR_PROPOSAL[`${proposal.lane}:${proposal.kind}`];
    if (!type) {
      dropped.push({ title: proposal.title, reason: `no opportunity type for ${proposal.lane}:${proposal.kind}` });
      continue;
    }
    const cluster = input.map.clusters.find((entry) => entry.slug === proposal.topicSlug) ?? null;
    const howEvidenceIds = proposal.evidenceRefs.filter((id) => !input.knowledgeEvidenceIds.includes(id)).slice(0, 8);
    const whyEvidenceIds = input.knowledgeEvidenceIds.slice(0, 2);
    try {
      // A refresh replaces the evidence this generated proposal rests on. Old
      // membership-only edges must not linger next to the new query/SERP edges.
      const existing = await db.opportunity.findUnique({
        where: { projectId_dedupKey: { projectId: input.projectId, dedupKey: proposal.dedupKey } },
        select: { id: true },
      });
      if (existing) {
        await db.evidenceEdge.deleteMany({
          where: {
            toType: "opportunity",
            toId: existing.id,
            relation: "supporting",
            createdBy: { in: ["phase3:topic-map", "phase5:weekly"] },
          },
        });
      }
      const record = await upsertOpportunity(db, {
        projectId: input.projectId,
        type,
        dimension: DIMENSION_FOR_TYPE[type],
        title: proposal.title,
        summary: proposal.summary,
        dedupKey: proposal.dedupKey,
        detectedBy: "phase3:topic-map",
        clusterId: proposal.topicSlug ? clusterIdBySlug.get(proposal.topicSlug) ?? null : null,
        scoreInputs: proposalScoreInputs(proposal, cluster) as never,
        whyEvidenceIds,
        howEvidenceIds: howEvidenceIds.length > 0 ? howEvidenceIds : proposal.evidenceRefs.slice(0, 4),
        recommendationDecision: {
          schemaVersion: "phase3-v1",
          source: "phase3-topic-map",
          readiness: proposal.kind === "business" ? "needs_investigation" : "actionable",
          lane: proposal.lane,
          kind: proposal.kind,
          title: proposal.title,
          summary: proposal.summary,
          whyNow: proposal.whyNow,
          evidenceRefs: proposal.evidenceRefs,
          target: proposal.target,
          action: proposal.action,
          expectedOutcome: proposal.expectedOutcome,
          effort: proposal.effort,
          confidence: proposal.confidence,
          expiresAt: proposal.expiresAt,
          topicSlug: proposal.topicSlug,
          sources: proposal.sources,
          critique: proposal.critique ?? null,
          topicMapRunId: input.topicMapRunId,
        },
        recommendationVersion: "phase3-v1",
        recommendationFingerprint: proposalHash(proposal),
        recommendationEvidenceId: proposal.evidenceRefs[0] ?? null,
      });
      stored.push({ id: record.id, dedupKey: proposal.dedupKey });
    } catch (error) {
      dropped.push({
        title: proposal.title,
        reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }
  return { stored, dropped };
}

export function renderProposalBoard(input: {
  map: TopicMap;
  proposals: Proposal[];
  dropped: Array<{ title: string; reason: string }>;
  critique: { available: boolean; model: string | null; summary: string | null; error: string | null };
  technical: ProposalInputs["technical"];
  generatedAt: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Opportunity board — ${input.map.domain} — ${input.map.month}`);
  lines.push("");
  lines.push(`Generated ${input.generatedAt}. Proposals only; no task is created until a human accepts one.`);
  lines.push("");
  lines.push("## Lanes");
  lines.push("");
  const lanes: Array<{ lane: ProposalLane; title: string }> = [
    { lane: "timely", title: "Timely" },
    { lane: "content_business", title: "Content & business" },
    { lane: "aeo_geo", title: "AEO/GEO" },
    { lane: "technical", title: "Technical" },
  ];
  for (const lane of lanes) {
    const laneProposals = input.proposals.filter((proposal) => proposal.lane === lane.lane);
    lines.push(`### ${lane.title}`);
    lines.push("");
    if (lane.lane === "technical") {
      if (input.technical.length === 0) lines.push("No existing technical opportunity in the current board.");
      for (const row of input.technical) {
        lines.push(`- **${row.title}** (${row.type}, score ${row.scoreValue ?? "—"}) — ${row.summary}`);
      }
      lines.push("");
      continue;
    }
    if (laneProposals.length === 0) {
      lines.push("No proposal in this lane.");
      lines.push("");
      continue;
    }
    for (const proposal of laneProposals) {
      lines.push(`#### ${proposal.title}`);
      lines.push("");
      lines.push(`- Kind: ${proposal.kind}; effort: ${proposal.effort}; confidence: ${proposal.confidence}`);
      lines.push(`- Summary: ${proposal.summary}`);
      if (proposal.whyNow) lines.push(`- Why now: ${proposal.whyNow}`);
      lines.push(`- Target: ${proposal.target.url ?? (proposal.target.newAsset ? "new asset" : "no page")}${proposal.target.section ? ` (${proposal.target.section})` : ""}`);
      lines.push(`- Action: ${proposal.action}`);
      lines.push(`- Expected outcome: ${proposal.expectedOutcome}`);
      lines.push(`- Evidence: ${proposal.evidenceRefs.length} reference(s)`);
      if (proposal.sources.length > 0) {
        lines.push(`- Sources: ${proposal.sources.map((source) => source.url).join(", ")}`);
      }
      if (proposal.expiresAt) lines.push(`- Expires: ${proposal.expiresAt.slice(0, 10)}`);
      if (proposal.critique) lines.push(`- Critique: ${proposal.critique.verdict} — ${proposal.critique.reason}`);
      lines.push("");
    }
  }
  lines.push("## Critique");
  lines.push("");
  if (input.critique.available) {
    lines.push(`Model: ${input.critique.model ?? "configured model"}.`);
    if (input.critique.summary) lines.push(`\n${input.critique.summary}`);
    if (input.critique.error) lines.push(`\nNote: ${input.critique.error}`);
  } else {
    lines.push(`Critique unavailable: ${input.critique.error ?? "unknown error"}. The proposals are shown as generated.`);
  }
  lines.push("");
  if (input.dropped.length > 0) {
    lines.push("Dropped:");
    lines.push("");
    for (const row of input.dropped) lines.push(`- ${row.title} — ${row.reason}`);
    lines.push("");
  }
  lines.push("## Limits");
  lines.push("");
  lines.push("- This board is a proposal set, not accepted work. No task, delivery or publication is created.");
  lines.push("- The deterministic proposals come from the reviewed topic map; the critique can drop or challenge them but cannot add queries, pages or evidence.");
  lines.push("- A business proposal with no target page is an investigation, not an article.");
  lines.push("- Technical items are the existing board opportunities; this phase does not re-score or replace them.");
  lines.push("");
  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
