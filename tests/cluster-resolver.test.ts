import { describe, expect, it } from "vitest";

import {
  clusterByQuery,
  normalizeQuery,
  queryFromDedupKey,
  resolveCluster,
} from "@/lib/funnel/cluster-resolver";

/**
 * CMP-002: an opportunity is filed under the cluster its query belongs to, and
 * the cluster is read from an accepted membership row rather than inferred.
 */

type Membership = { query: string; cluster: string };

function fakeDb(memberships: Membership[], clusters: Array<{ id: string; slug: string }>) {
  return {
    evidenceRecord: {
      findMany: async (input: { where: { kind: string } }) =>
        input.where.kind === "keyword_universe_membership"
          ? memberships.map((m) => ({ dimensions: { query: m.query, cluster: m.cluster, source: "topic-map-v1" } }))
          : [],
    },
    demandMapCluster: {
      findMany: async () => clusters,
    },
  };
}

describe("normalizeQuery", () => {
  it("folds case, accents and whitespace", () => {
    expect(normalizeQuery("Tapisserie  de Siège")).toBe("tapisserie de siege");
    expect(normalizeQuery("  LUMINAIRE ARTISANAL ")).toBe("luminaire artisanal");
  });

  it("keeps plural and word order distinct, because the model owns those", () => {
    expect(normalizeQuery("lampe artisanale")).not.toBe(normalizeQuery("lampes artisanales"));
    expect(normalizeQuery("mayan riviera")).not.toBe(normalizeQuery("riviera maya"));
  });
});

describe("clusterByQuery", () => {
  it("maps each accepted membership to its cluster id", async () => {
    const db = fakeDb(
      [{ query: "tapisserie de siège", cluster: "restauration-siege-fauteuil" }],
      [{ id: "c1", slug: "restauration-siege-fauteuil" }]
    );
    const map = await clusterByQuery(db as never, "p1");
    expect(map.get("tapisserie de siege")).toEqual({ clusterId: "c1", slug: "restauration-siege-fauteuil" });
  });

  it("drops a membership pointing at a cluster that no longer exists", async () => {
    const db = fakeDb([{ query: "gone topic", cluster: "deleted-slug" }], []);
    const map = await clusterByQuery(db as never, "p1");
    expect(map.size).toBe(0);
  });

  it("ignores a membership with no query or no cluster", async () => {
    const db = fakeDb([{ query: "", cluster: "x" }, { query: "y", cluster: "" }], [{ id: "c1", slug: "x" }]);
    const map = await clusterByQuery(db as never, "p1");
    expect(map.size).toBe(0);
  });
});

describe("resolveCluster", () => {
  const byQuery = new Map([["luminaire artisanal", { clusterId: "c1", slug: "achat-lampe-artisanale" }]]);
  const slugToId = new Map([["achat-lampe-artisanale", "c1"]]);

  it("resolves from the query when a membership exists", () => {
    expect(resolveCluster({ query: "Luminaire Artisanal", byQuery, slugToId })).toEqual({
      clusterId: "c1",
      slug: "achat-lampe-artisanale",
    });
  });

  it("resolves from a slug the detector already carries", () => {
    expect(resolveCluster({ query: null, slug: "achat-lampe-artisanale", byQuery, slugToId })).toEqual({
      clusterId: "c1",
      slug: "achat-lampe-artisanale",
    });
  });

  it("leaves an unclustered query unclustered instead of guessing", () => {
    expect(resolveCluster({ query: "some unrelated query", byQuery, slugToId })).toBeNull();
    expect(resolveCluster({ query: null, slug: null, byQuery, slugToId })).toBeNull();
  });

  it("does not attach a near-miss to the nearest topic", () => {
    // Plural differs, so it is a different query; the model decides that, not code.
    expect(resolveCluster({ query: "luminaires artisanaux", byQuery, slugToId })).toBeNull();
  });
});

describe("queryFromDedupKey", () => {
  it("reads the query from a key that carries one", () => {
    expect(queryFromDedupKey("O1:art et tapisserie:https://www.atelier-harmonie.com/")).toBe("art et tapisserie");
    expect(queryFromDedupKey("O2:tapisserie de siège:https://x.test/a")).toBe("tapisserie de siège");
  });

  it("returns nothing for an opaque hash key", () => {
    // Measured: 71 of 75 live dedup keys are hashes like this.
    expect(queryFromDedupKey("phase3:content_business:a51600fd979a6c3f")).toBeNull();
    expect(queryFromDedupKey("O8_structured_data_gap:site:identity")).toBeNull();
  });

  it("returns nothing for a key with no second segment", () => {
    expect(queryFromDedupKey("solo")).toBeNull();
  });
});
