import { describe, expect, it } from "vitest";

import {
  assignQuery,
  buildTopicMap,
  normalizeTopicText,
  renderTopicMapMarkdown,
  scoreTopicForQuery,
  storeTopicMap,
  type TopicMapData,
} from "@/lib/research/topic-map";
import { ATELIER_TOPIC_TAXONOMY } from "@/lib/research/topic-taxonomy";

const taxonomy = ATELIER_TOPIC_TAXONOMY;

function page(path: string, title: string, type: TopicMapData["pages"][number]["type"], wordCount = 400) {
  const text = normalizeTopicText(`${path} ${title}`);
  return {
    url: `https://atelier.example${path}`,
    path,
    title,
    description: "",
    h1: "",
    wordCount,
    type,
    text,
  };
}

function data(overrides: Partial<TopicMapData> = {}): TopicMapData {
  return {
    site: { id: "site-1", domain: "atelier.example", projectId: "proj-1" },
    context: { language: "fr", country: "FR" } as never,
    fields: {
      businessName: { value: "Atelier Test" },
      services: { value: ["Restauration de siège", "Restauration d'abat-jour"] },
      location: { value: "Saint-Pierre-en-Port, France" },
      serviceArea: { value: ["Normandie"] },
    },
    queries: [],
    pages: [],
    aeo: [],
    news: [],
    month: "2026-11",
    ...overrides,
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

describe("topic assignment", () => {
  it("separates abat-jour restoration from creation", () => {
    expect(scoreTopicForQuery("réparation abat jour", taxonomy.find((topic) => topic.slug === "restauration-abat-jour")!)).toBeGreaterThan(0);
    expect(assignQuery("réparation abat jour", taxonomy)[0].topic.slug).toBe("restauration-abat-jour");
    expect(assignQuery("abat jour pagode", taxonomy)[0].topic.slug).toBe("creation-abat-jour");
  });

  it("keeps a bare head term in one topic instead of inflating two", () => {
    const assigned = assignQuery("abat-jour", taxonomy);
    expect(assigned.map((entry) => entry.topic.slug)).toEqual(["creation-abat-jour"]);
  });

  it("assigns brand queries only to the brand topic", () => {
    const assigned = assignQuery("atelier harmonie", taxonomy);
    expect(assigned.map((entry) => entry.topic.slug)).toEqual(["marque"]);
    expect(assignQuery("harmonie atelier", taxonomy).map((entry) => entry.topic.slug)).toEqual(["marque"]);
  });

  it("allows a local query to belong to the local and service topics", () => {
    const assigned = assignQuery("tapissier autour de moi", taxonomy);
    expect(assigned[0].topic.slug).toBe("local-normandie");
    expect(assigned.map((entry) => entry.topic.slug)).toContain("restauration-siege");
  });

  it("does not treat a generic atelier query as a workshop", () => {
    expect(assignQuery("atelier sainte adresse", taxonomy).some((entry) => entry.topic.slug === "kits-ateliers")).toBe(false);
    expect(assignQuery("kit lampe", taxonomy)[0].topic.slug).toBe("kits-ateliers");
  });
});

describe("topic map build", () => {
  it("maps demand to pages and reports the real gaps", () => {
    const map = buildTopicMap(
      data({
        queries: [
          query("fauteuil restauration", 40, 480),
          query("réparation abat jour", 60, 30),
          query("abat jour pagode", 50, 390),
          query("luminaire artisanal", 100),
          query("plafonnier artisanal", 90),
          query("kit lampe", 80, 110),
          query("tapissier autour de moi", 20),
          query("carte cadeau décoration le mans", 12),
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
      }),
      taxonomy
    );

    const seat = map.clusters.find((cluster) => cluster.slug === "restauration-siege")!;
    expect(seat.coverage).toBe("strong");
    expect(seat.pages[0].url).toContain("/tapisserie-restauration");

    const restoration = map.clusters.find((cluster) => cluster.slug === "restauration-abat-jour")!;
    expect(restoration.coverage).toBe("partial");
    expect(restoration.gaps.join(" ")).toMatch(/no service or category page/i);

    const lighting = map.clusters.find((cluster) => cluster.slug === "luminaires")!;
    expect(lighting.gaps.join(" ")).toMatch(/plafonnier/);
    expect(lighting.pages[0].url).toContain("/lampes");

    const local = map.clusters.find((cluster) => cluster.slug === "local-normandie")!;
    expect(local.gaps.join(" ")).toMatch(/dedicated local landing page/i);
    expect(local.gaps.join(" ")).toMatch(/le mans|off-area/i);
  });

  it("renders a readable report with the topic table and unmapped demand", () => {
    const map = buildTopicMap(
      data({
        queries: [query("tenue sexie", 0, 18_100), query("fauteuil restauration", 40, 480)],
        pages: [page("/tapisserie-restauration", "Restauration de Sièges", "service", 712)],
      }),
      taxonomy
    );
    const markdown = renderTopicMapMarkdown(map);
    expect(markdown).toContain("# Topic map");
    expect(markdown).toContain("## Topic table");
    expect(markdown).toContain("Restauration de sièges");
    expect(markdown).toContain("tenue sexie");
    expect(markdown).toContain("Off-business");
  });
});

describe("topic map storage", () => {
  it("upserts clusters and writes memberships without a new table", async () => {
    const state: {
      clusters: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown>>;
    } = { clusters: [], evidence: [] };

    const db = {
      demandMapCluster: {
        findMany: async () => state.clusters.filter((row) => !row.supersededAt),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `cluster-${state.clusters.length + 1}`, tracked: false, supersededAt: null, ...data };
          state.clusters.push(row);
          return { id: row.id };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.clusters.find((entry) => entry.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      },
      evidenceRecord: {
        findMany: async ({
          where,
        }: {
          where: {
            kind?: string;
            supersededById?: string | null;
            dimensions?: { path?: string[]; equals?: unknown };
          };
        }) => {
          const path = where.dimensions?.path?.[0];
          const equals = where.dimensions?.equals;
          return state.evidence.filter((row) => {
            if (where.kind && row.kind !== where.kind) return false;
            if (where.supersededById === null && row.supersededById) return false;
            if (path && (row.dimensions as Record<string, unknown>)?.[path] !== equals) return false;
            return true;
          });
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.evidence.find((entry) => entry.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          const row = { id: `evidence-${state.evidence.length + 1}`, supersededById: null, ...create };
          state.evidence.push(row);
          return row;
        },
      },
      rawProviderResponse: { findUnique: async () => null },
    };

    const map = buildTopicMap(
      data({
        queries: [query("fauteuil restauration", 40, 480), query("réparation abat jour", 60, 30)],
        pages: [page("/tapisserie-restauration", "Restauration de Sièges", "service", 712)],
      }),
      taxonomy
    );

    const result = await storeTopicMap(db as never, map);
    expect(result.created).toBe(taxonomy.length);
    expect(result.memberships).toBeGreaterThan(0);
    expect(state.clusters).toHaveLength(taxonomy.length);
    expect(state.evidence.some((row) => row.kind === "keyword_universe_membership")).toBe(true);
    expect(state.evidence.some((row) => (row.dimensions as Record<string, unknown>).cluster === "restauration-siege")).toBe(true);
  });
});
