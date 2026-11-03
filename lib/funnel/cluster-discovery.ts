import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord } from "@/lib/funnel/evidence";

/**
 * Demand-map cluster discovery (docs/demand-map-cluster-discovery.md).
 *
 * Signals propose clusters from stored evidence only — no paid calls. A
 * proposal is reconciled against existing clusters by member overlap, so a
 * re-run lands on the same rows instead of forking the map.
 */

export type DiscoveryDb = Pick<
  PrismaClient,
  "demandMapCluster" | "evidenceRecord" | "evidenceEdge"
> & Parameters<typeof storeEvidenceRecord>[0];

export type ClusterProposal = {
  /** Stable identity derived from the members, never from the display name. */
  identityKey: string;
  name: string;
  topicSummary: string;
  intent: "informational" | "commercial" | "transactional" | "local" | "mixed";
  proposedBy: string;
  confidence: number;
  /** Query strings that belong to this cluster. */
  members: string[];
  /** Observation time taken from the data, not the run (idempotency). */
  observedAt: Date;
};

export const DISCOVERY_THRESHOLDS = {
  /** A lexical bigram must cover at least this many queries to be a cluster. */
  minMembers: 2,
  /** Jaccard overlap at or above this merges a proposal into an existing cluster. */
  mergeThreshold: 0.5,
  /** Two queries sharing this share of top results are the same need. */
  serpOverlapThreshold: 0.5,
} as const;

const STOPWORDS = new Set([
  // English
  "the", "and", "for", "with", "from", "that", "this", "your", "you", "our", "are", "was", "how", "what", "why",
  "when", "where", "who", "which", "best", "top", "vs", "near", "about", "into", "out", "not", "but", "all", "can",
  "does", "do", "is", "it", "to", "of", "in", "on", "at", "by", "a", "an",
  // Spanish (the sites in this workspace are ES/MX)
  "el", "la", "los", "las", "de", "del", "en", "y", "o", "un", "una", "unos", "unas", "por", "para", "con", "sin",
  "que", "como", "donde", "cuando", "cual", "cuales", "es", "son", "al", "se", "su", "sus", "mi", "tu", "lo",
  "mas", "muy", "ya", "si", "no",
]);

export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function significantTokens(query: string): string[] {
  return normalizeQuery(query)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

export function slugify(value: string): string {
  return normalizeQuery(value).replace(/\s+/g, "-").slice(0, 60) || "cluster";
}

/** Union-find so overlapping groups merge into connected components. */
function components(groups: Map<string, Set<string>>): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let current = x;
    while (parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const queries of groups.values()) {
    const list = [...queries];
    for (const query of list) if (!parent.has(query)) parent.set(query, query);
    for (let i = 1; i < list.length; i += 1) union(list[0], list[i]);
  }
  const byRoot = new Map<string, Set<string>>();
  for (const query of parent.keys()) {
    const root = find(query);
    byRoot.set(root, (byRoot.get(root) ?? new Set()).add(query));
  }
  return [...byRoot.values()].map((set) => [...set].sort());
}

/**
 * Signal 1: Search Console queries grouped by a shared significant phrase.
 * Declared heuristic, auditable: every member is a stored query and the shared
 * phrase is the stated reason for grouping.
 */
export function proposeLexicalClusters(
  queries: Array<{ query: string; observedAt: Date }>,
  opts: { minMembers?: number } = {}
): ClusterProposal[] {
  const minMembers = opts.minMembers ?? DISCOVERY_THRESHOLDS.minMembers;
  const byBigram = new Map<string, Set<string>>();
  const observedAtByQuery = new Map<string, Date>();
  for (const row of queries) {
    const tokens = significantTokens(row.query);
    if (tokens.length === 0) continue;
    observedAtByQuery.set(row.query, row.observedAt);
    for (const gram of bigrams(tokens)) {
      byBigram.set(gram, (byBigram.get(gram) ?? new Set()).add(row.query));
    }
  }

  // Only bigrams with enough support propose a cluster.
  const supported = new Map<string, Set<string>>();
  for (const [gram, members] of byBigram) if (members.size >= minMembers) supported.set(gram, members);

  const proposals: ClusterProposal[] = [];
  for (const members of components(supported)) {
    if (members.length < minMembers) continue;
    // The name is the shared phrase with the most members; identity is the
    // phrase itself, so a re-run cannot invent a different row.
    let best = "";
    let bestCount = -1;
    for (const [gram, gramMembers] of supported) {
      const overlap = members.filter((query) => gramMembers.has(query)).length;
      if (overlap > bestCount) {
        best = gram;
        bestCount = overlap;
      }
    }
    const observedAt = members.reduce<Date>((latest, query) => {
      const at = observedAtByQuery.get(query);
      return at && at > latest ? at : latest;
    }, new Date(0));
    proposals.push({
      identityKey: `lexical:${best}`,
      name: best,
      topicSummary: `${members.length} queries sharing the phrase “${best}”.`,
      intent: inferIntent(members),
      proposedBy: "gsc_query",
      confidence: Math.min(1, members.length / 10),
      members,
      observedAt: observedAt.getTime() === 0 ? new Date() : observedAt,
    });
  }
  return proposals.sort((a, b) => b.members.length - a.members.length);
}

/**
 * Intent from wording, most specific first: a local signal beats a
 * transactional one because "near me" narrows the need more than "cheap" does.
 */
function inferIntent(queries: string[]): ClusterProposal["intent"] {
  const text = queries.join(" ").toLowerCase();
  if (/\b(near me|cerca|playa|bacalar|tulum|cancun|city|local)\b/.test(text)) return "local";
  if (/\b(price|prices|cost|cheap|buy|book|booking|reserve|precio|comprar|reservar)\b/.test(text)) return "transactional";
  if (/\b(vs|best|review|compare|alternative|mejor)\b/.test(text)) return "commercial";
  if (/\b(how|what|why|guide|learn|que|cual)\b/.test(text)) return "informational";
  return "mixed";
}

/**
 * Signal 2: queries whose top results overlap. Objective rather than inferred,
 * so it is preferred when SERP evidence exists.
 */
export function proposeSerpClusters(
  snapshots: Array<{ query: string; urls: string[]; observedAt: Date }>
): ClusterProposal[] {
  if (snapshots.length < 2) return [];
  const sets = new Map(snapshots.map((row) => [row.query, new Set(row.urls)]));
  const adjacency = new Map<string, Set<string>>();
  for (let i = 0; i < snapshots.length; i += 1) {
    for (let j = i + 1; j < snapshots.length; j += 1) {
      const a = sets.get(snapshots[i].query)!;
      const b = sets.get(snapshots[j].query)!;
      const shared = [...a].filter((url) => b.has(url)).length;
      const union = new Set([...a, ...b]).size;
      const jaccard = union === 0 ? 0 : shared / union;
      if (jaccard >= DISCOVERY_THRESHOLDS.serpOverlapThreshold) {
        adjacency.set(snapshots[i].query, (adjacency.get(snapshots[i].query) ?? new Set()).add(snapshots[j].query));
        adjacency.set(snapshots[j].query, (adjacency.get(snapshots[j].query) ?? new Set()).add(snapshots[i].query));
      }
    }
  }
  const seen = new Set<string>();
  const proposals: ClusterProposal[] = [];
  for (const row of snapshots) {
    if (seen.has(row.query)) continue;
    // Connected component via BFS.
    const queue = [row.query];
    const members: string[] = [];
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      members.push(current);
      for (const next of adjacency.get(current) ?? []) if (!seen.has(next)) queue.push(next);
    }
    if (members.length < 2) continue;
    const hub = members
      .map((query) => ({ query, degree: adjacency.get(query)?.size ?? 0 }))
      .sort((a, b) => b.degree - a.degree)[0].query;
    const observedAt = members.reduce<Date>((latest, query) => {
      const at = snapshots.find((snap) => snap.query === query)?.observedAt ?? latest;
      return at > latest ? at : latest;
    }, new Date(0));
    proposals.push({
      identityKey: `serp:${normalizeQuery(hub)}`,
      name: hub,
      topicSummary: `${members.length} queries sharing the same top results.`,
      intent: inferIntent(members),
      proposedBy: "serp_overlap",
      confidence: Math.min(1, members.length / 8),
      members,
      observedAt: observedAt.getTime() === 0 ? new Date() : observedAt,
    });
  }
  return proposals.sort((a, b) => b.members.length - a.members.length);
}

/** Signal 3: the questions business knowledge says customers ask. */
export function proposeKnowledgeClusters(
  questions: Array<{ question: string; observedAt: Date }>
): ClusterProposal[] {
  return questions.map((row) => ({
    identityKey: `knowledge:${createHash("sha256").update(normalizeQuery(row.question)).digest("hex").slice(0, 16)}`,
    name: row.question,
    topicSummary: "A question from canonical business knowledge. Intent only until demand validates it.",
    intent: "informational" as const,
    proposedBy: "knowledge_prior",
    confidence: 0.2,
    members: [row.question],
    observedAt: row.observedAt,
  }));
}

export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  const shared = [...setA].filter((value) => setB.has(value)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : shared / union;
}

export type ReconcileResult = {
  created: number;
  merged: number;
  superseded: number;
  memberships: number;
};

/**
 * Reconcile proposals against the existing map.
 *
 * Matching is by member overlap, not by name: a re-run that phrases the cluster
 * differently still lands on the same row. A cluster that ends with no members
 * is superseded, never deleted.
 */
export async function reconcileClusters(
  db: DiscoveryDb,
  projectId: string,
  proposals: ClusterProposal[]
): Promise<ReconcileResult> {
  const result: ReconcileResult = { created: 0, merged: 0, superseded: 0, memberships: 0 };

  const existing = await db.demandMapCluster.findMany({
    where: { projectId, supersededById: null },
    select: { id: true, slug: true, identityKey: true, name: true, confidence: true },
  });
  // Membership is read from evidence so reconciliation never invents members.
  const memberships = await db.evidenceRecord.findMany({
    where: { projectId, kind: "keyword_universe_membership", supersededById: null },
    select: { dimensions: true },
  });
  const membersBySlug = new Map<string, string[]>();
  for (const row of memberships) {
    const dims = (row.dimensions ?? {}) as { cluster?: string; query?: string };
    if (!dims.cluster || !dims.query) continue;
    membersBySlug.set(dims.cluster, [...(membersBySlug.get(dims.cluster) ?? []), dims.query]);
  }

  const touched = new Set<string>();
  const slugTaken = new Set(existing.map((row) => row.slug));

  for (const proposal of proposals) {
    const currentMembers = existing
      .map((row) => ({ row, members: membersBySlug.get(row.slug) ?? [] }))
      .map((entry) => ({ ...entry, score: jaccard(proposal.members, entry.members) }))
      .sort((a, b) => b.score - a.score)[0];

    let clusterId: string;
    let slug: string;

    if (currentMembers && currentMembers.score >= DISCOVERY_THRESHOLDS.mergeThreshold) {
      slug = currentMembers.row.slug;
      clusterId = currentMembers.row.id;
      await db.demandMapCluster.update({
        where: { id: clusterId },
        data: {
          // Keep the existing name when it already describes the members better.
          name: proposal.name.length > 0 && proposal.members.length > (membersBySlug.get(slug) ?? []).length ? proposal.name : currentMembers.row.name,
          topicSummary: proposal.topicSummary,
          confidence: Math.max(currentMembers.row.confidence ?? 0, proposal.confidence),
          intent: proposal.intent,
        },
      });
      result.merged += 1;
    } else {
      const identityMatch = existing.find((row) => row.identityKey === proposal.identityKey);
      if (identityMatch) {
        slug = identityMatch.slug;
        clusterId = identityMatch.id;
        result.merged += 1;
      } else {
        slug = uniqueSlug(slugify(proposal.name), slugTaken);
        slugTaken.add(slug);
        const created = await db.demandMapCluster.create({
          data: {
            projectId,
            slug,
            identityKey: proposal.identityKey,
            name: proposal.name,
            topicSummary: proposal.topicSummary,
            intent: proposal.intent,
            // Discovery never endorses: relevance stays "none" until a person decides.
            businessRelevance: { relevance: "none", proposedBy: proposal.proposedBy },
            proposedBy: proposal.proposedBy,
            confidence: proposal.confidence,
          },
          select: { id: true },
        });
        clusterId = created.id;
        result.created += 1;
      }
    }

    touched.add(slug);
    for (const query of proposal.members) {
      await storeEvidenceRecord(db, {
        projectId,
        kind: "keyword_universe_membership",
        observedAt: proposal.observedAt,
        producer: `cluster-discovery:${proposal.proposedBy}`,
        dimensions: { cluster: slug, query, source: proposal.proposedBy },
        metrics: {},
      });
      result.memberships += 1;
    }
  }

  // A cluster that no longer receives members is superseded, not deleted.
  for (const row of existing) {
    if (touched.has(row.slug)) continue;
    const members = membersBySlug.get(row.slug) ?? [];
    if (members.length === 0) continue; // never had members: leave for curation
    await db.demandMapCluster.update({
      where: { id: row.id },
      data: { supersededById: row.id },
    });
    result.superseded += 1;
  }

  return result;
}

function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export type DiscoverDb = DiscoveryDb & Pick<PrismaClient, "keyword">;

/**
 * Discover clusters for a project from stored evidence. No paid calls.
 * Signals run in preference order; SERP overlap wins over lexical grouping
 * when both describe the same members because reconciliation merges by overlap.
 */
export async function discoverClusters(
  db: DiscoverDb,
  projectId: string,
  opts: { siteId?: string | null } = {}
): Promise<ReconcileResult & { proposals: number }> {
  const rankEvidence = await db.evidenceRecord.findMany({
    where: { projectId, kind: "keyword_rank", supersededById: null },
    select: { dimensions: true, observedAt: true },
  });
  const queries = new Map<string, Date>();
  for (const row of rankEvidence) {
    const dims = (row.dimensions ?? {}) as { query?: string };
    if (!dims.query) continue;
    const current = queries.get(dims.query);
    if (!current || row.observedAt > current) queries.set(dims.query, row.observedAt);
  }

  const proposals: ClusterProposal[] = [
    ...proposeSerpClusters(
      await serpSnapshots(db, projectId)
    ),
    ...proposeLexicalClusters([...queries.entries()].map(([query, observedAt]) => ({ query, observedAt }))),
    ...proposeKnowledgeClusters(await knowledgeQuestions(db, projectId)),
  ];

  const result = await reconcileClusters(db, projectId, proposals);
  return { ...result, proposals: proposals.length };
}

async function serpSnapshots(
  db: DiscoverDb,
  projectId: string
): Promise<Array<{ query: string; urls: string[]; observedAt: Date }>> {
  const rows = await db.evidenceRecord.findMany({
    where: { projectId, kind: "serp_snapshot", supersededById: null },
    select: { dimensions: true, observedAt: true },
  });
  return rows.flatMap((row) => {
    const dims = (row.dimensions ?? {}) as { query?: string; urls?: unknown };
    const urls = Array.isArray(dims.urls) ? dims.urls.filter((url): url is string => typeof url === "string") : [];
    if (!dims.query || urls.length === 0) return [];
    return [{ query: dims.query, urls, observedAt: row.observedAt }];
  });
}

async function knowledgeQuestions(db: DiscoverDb, projectId: string): Promise<Array<{ question: string; observedAt: Date }>> {
  const rows = await db.evidenceRecord.findMany({
    where: { projectId, kind: "knowledge_fact", supersededById: null },
    select: { dimensions: true, observedAt: true },
  });
  return rows.flatMap((row) => {
    const dims = (row.dimensions ?? {}) as { question?: string };
    return dims.question ? [{ question: dims.question, observedAt: row.observedAt }] : [];
  });
}
