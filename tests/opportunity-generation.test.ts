import { describe, expect, it } from "vitest";

import {
  buildDeterministicProposals,
  dedupeProposals,
  proposalScoreInputs,
  storeProposals,
  validateProposal,
  type Proposal,
  type ProposalInputs,
} from "@/lib/research/opportunity-generation";
import { buildTopicMap, normalizeTopicText, type TopicMapData } from "@/lib/research/topic-map";
import { ATELIER_TOPIC_TAXONOMY } from "@/lib/research/topic-taxonomy";

function page(path: string, title: string, type: TopicMapData["pages"][number]["type"], wordCount = 400) {
  return {
    url: `https://atelier-harmonie.example${path}`,
    path,
    title,
    description: "",
    h1: "",
    wordCount,
    type,
    text: normalizeTopicText(`${path} ${title}`),
  };
}

function query(value: string, impressions: number, volume: number | null = null) {
  return {
    query: value,
    impressions,
    clicks: 0,
    position: 10,
    volume,
    difficulty: null,
    observedAt: new Date("2026-11-04T00:00:00Z"),
  };
}

function makeInputs(overrides: Partial<ProposalInputs> = {}): ProposalInputs {
  const data: TopicMapData = {
    site: { id: "site-1", domain: "atelier-harmonie.example", projectId: "proj-1" },
    marketScope: { default: "local", offers: [] },
    context: { language: "fr", country: "FR" } as never,
    fields: {
      businessName: { value: "Atelier Test" },
      services: { value: ["Restauration de siège", "Restauration d'abat-jour"] },
      location: { value: "Saint-Pierre-en-Port, France" },
      serviceArea: { value: ["Normandie"] },
    },
    queries: [
      query("réparation abat jour", 60, 30),
      query("comment réparer un abat jour", 30),
      query("comment restaurer un abat jour", 20),
      query("abat jour pagode", 50, 390),
      query("luminaire artisanal", 100),
      query("plafonnier artisanal", 90),
      query("fauteuil restauration", 40, 480),
      query("kit lampe", 80, 110),
    ],
    pages: [
      page("/tapisserie-restauration", "Restauration de Sièges & Création sur mesure", "service", 712),
      page("/lampes", "Créations Lumineuses Artisanales & Uniques", "category", 342),
      page("/lampes/abat-jours", "Abat-jour artisanaux uniques et faits main", "category", 150),
      page("/les-ateliers", "Ateliers DIY en Normandie", "service", 721),
      page("/gift-card", "Carte Cadeau Artisanat & Déco", "product", 334),
      page("/post/restauration-abat-jour", "L'art de la restauration : abat-jour en contrecollé", "blog", 854),
      page("/", "Atelier de l'harmonie | restauration de siege | Saint-Pierre-en-Port", "home", 698),
    ],
    aeo: [],
    news: [],
    month: "2026-11",
  };
  const map = buildTopicMap(data, ATELIER_TOPIC_TAXONOMY);
  const clusters = map.clusters.map((cluster, index) => ({ id: `cluster-${index}`, slug: cluster.slug }));
  const evidenceByCluster = new Map<string, string[]>(
    map.clusters.map((cluster) => [cluster.slug, [`ev-${cluster.slug}-1`, `ev-${cluster.slug}-2`]])
  );
  const now = Date.now();
  return {
    site: { id: "site-1", domain: "atelier-harmonie.example", projectId: "proj-1" },
    map,
    topicMapRunId: "topic-run-1",
    clusters,
    evidenceByCluster,
    knowledgeEvidenceIds: ["k1", "k2"],
    aeoEvidence: [
      { id: "aeo-1", question: "luminaire artisanal", cited: 0, competitorCited: 3 },
      { id: "aeo-2", question: "plafonnier artisanal", cited: 0, competitorCited: 3 },
      { id: "aeo-3", question: "comment réparer un abat jour", cited: 0, competitorCited: 2 },
      { id: "aeo-4", question: "comment restaurer un abat jour", cited: 0, competitorCited: 2 },
      { id: "aeo-5", question: "blogging artisanat", cited: 0, competitorCited: 1 },
    ],
    news: [
      { id: "news-1", title: "Recent local press", url: "https://news.example/recent", publishedAt: new Date(now - 10 * 86_400_000).toISOString(), excerpt: null },
      { id: "news-2", title: "Old local press", url: "https://news.example/old", publishedAt: new Date(now - 60 * 86_400_000).toISOString(), excerpt: null },
    ],
    technical: [],
    ...overrides,
  };
}

function evidenceSet(inputs: ProposalInputs, proposals: Proposal[]): Set<string> {
  const ids = new Set<string>([...inputs.knowledgeEvidenceIds]);
  for (const proposal of proposals) for (const id of proposal.evidenceRefs) ids.add(id);
  return ids;
}

describe("proposal generation", () => {
  it("turns the topic gaps into specific content and business proposals", () => {
    const inputs = makeInputs();
    const proposals = buildDeterministicProposals(inputs);
    const restoration = proposals.find((proposal) => proposal.title.includes("Restauration d'abat-jour"));
    expect(restoration).toMatchObject({
      lane: "content_business",
      kind: "article",
      target: { url: "/restauration-abat-jour", newAsset: true },
    });
    expect(proposals.some((proposal) => proposal.title.includes("catégorie Abat-jours"))).toBe(true);
    expect(proposals.some((proposal) => proposal.kind === "business" && proposal.title.includes("plafonnier"))).toBe(true);
    expect(proposals.some((proposal) => proposal.lane === "content_business" && proposal.title.includes("sièges"))).toBe(true);
  });

  it("creates AEO proposals only for measured, relevant topics", () => {
    const inputs = makeInputs();
    const proposals = buildDeterministicProposals(inputs);
    const aeo = proposals.filter((proposal) => proposal.lane === "aeo_geo");
    expect(aeo.map((proposal) => proposal.topicSlug)).toEqual(["luminaires", "restauration-abat-jour"]);
    expect(aeo.find((proposal) => proposal.topicSlug === "restauration-abat-jour")?.target).toMatchObject({
      url: "/restauration-abat-jour",
      newAsset: true,
    });
    expect(aeo.some((proposal) => proposal.topicSlug === "blog-artisanat")).toBe(false);
  });

  it("creates a timely proposal only from recent news", () => {
    const inputs = makeInputs();
    const proposals = buildDeterministicProposals(inputs);
    const timely = proposals.find((proposal) => proposal.lane === "timely");
    expect(timely).toBeDefined();
    expect(timely?.sources[0].url).toBe("https://news.example/recent");
    expect(timely?.expiresAt).toBeTruthy();
    expect(Date.parse(timely!.expiresAt!)).toBeGreaterThan(Date.now());

    const oldOnly = makeInputs({ news: [{ id: "news-old", title: "Old", url: "https://news.example/old", publishedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(), excerpt: null }] });
    expect(buildDeterministicProposals(oldOnly).some((proposal) => proposal.lane === "timely")).toBe(false);
  });

  it("deduplicates identical proposals", () => {
    const proposals = buildDeterministicProposals(makeInputs());
    expect(dedupeProposals([...proposals, ...proposals])).toHaveLength(proposals.length);
  });
});

describe("proposal validation", () => {
  it("rejects missing evidence, off-site targets and invalid timely items", () => {
    const inputs = makeInputs();
    const proposals = buildDeterministicProposals(inputs);
    const evidenceIds = evidenceSet(inputs, proposals);
    const valid = proposals[0];
    expect(validateProposal(valid, { domain: "atelier-harmonie.example", evidenceIds })).toBeNull();
    expect(validateProposal({ ...valid, evidenceRefs: ["missing"] }, { domain: "atelier-harmonie.example", evidenceIds })).toMatch(/unknown evidence/);
    expect(validateProposal({ ...valid, target: { url: "https://other.example/page", newAsset: false, section: null } }, { domain: "atelier-harmonie.example", evidenceIds })).toMatch(/not on the site/);
    expect(validateProposal({ ...valid, lane: "timely", whyNow: null, expiresAt: null }, { domain: "atelier-harmonie.example", evidenceIds })).toMatch(/whyNow/);
    expect(validateProposal({ ...valid, target: { url: null, newAsset: false, section: null } }, { domain: "atelier-harmonie.example", evidenceIds })).toMatch(/needs a target/);
  });

  it("declares the score inputs instead of hiding them", () => {
    const inputs = makeInputs();
    const proposal = buildDeterministicProposals(inputs)[0];
    const cluster = inputs.map.clusters.find((entry) => entry.slug === proposal.topicSlug) ?? null;
    const score = proposalScoreInputs(proposal, cluster);
    expect(score.worth.change).toBe(proposal.action);
    expect(score.worth.successMeasure).toBe(proposal.expectedOutcome);
    expect(score.effort.playTypeBase).toBe(8);
  });
});

describe("proposal storage", () => {
  it("stores proposals in the existing Opportunity table and records evidence edges", async () => {
    const inputs = makeInputs();
    const proposals = buildDeterministicProposals(inputs);
    const evidenceIds = evidenceSet(inputs, proposals);
    let created = 0;
    let edges = 0;
    const db = {
      opportunity: {
        findUnique: async () => null,
        create: async () => {
          created += 1;
          return { id: `opp-${created}`, status: "detected" };
        },
        update: async () => ({ id: "opp-1", status: "detected" }),
      },
      evidenceEdge: {
        upsert: async () => {
          edges += 1;
          return { id: `edge-${edges}` };
        },
      },
    };
    const result = await storeProposals(db as never, {
      projectId: "proj-1",
      siteId: "site-1",
      domain: "atelier-harmonie.example",
      map: inputs.map,
      topicMapRunId: "topic-run-1",
      proposals,
      evidenceIds,
      knowledgeEvidenceIds: inputs.knowledgeEvidenceIds,
      clusters: inputs.clusters,
    });
    expect(result.dropped).toHaveLength(0);
    expect(result.stored).toHaveLength(proposals.length);
    expect(created).toBe(proposals.length);
    expect(edges).toBeGreaterThan(0);
  });
});
