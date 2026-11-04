import { describe, expect, it } from "vitest";

import { clusterFindings } from "@/lib/research/finding-evidence";

/**
 * Findings were deduped on the summary text, so a re-run that phrased the same
 * insight differently produced a second opportunity. One tenant carried three
 * sargassum risks and two Tulum-oversupply rows: five insights, ten rows.
 */
describe("finding dedup", () => {
  const finding = (id: string, theme: string) => ({
    id,
    theme,
    summary: `Summary for ${theme}`,
    confidence: 0,
    createdAt: new Date("2026-11-01T00:00:00Z"),
  });

  it("merges re-phrasings of the same insight", () => {
    const clusters = clusterFindings([
      finding("a", "Sargassum and coastal property risk"),
      finding("b", "Sargassum and beach quality risk to rental income"),
      finding("c", "Sargassum as a coastal rental/tourism risk"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
    expect(clusters[0].key).toContain("sargassum");
  });

  it("keeps different insights apart", () => {
    const clusters = clusterFindings([
      finding("a", "Sargassum and coastal property risk"),
      finding("b", "Ownership FAQ and glossary hub"),
      finding("c", "Tulum exodus and oversupply narrative"),
    ]);
    expect(clusters).toHaveLength(3);
  });

  it("gives the cluster an identity that survives re-phrasing", () => {
    const first = clusterFindings([
      finding("a", "Sargassum and coastal property risk"),
      finding("b", "Sargassum and beach quality risk to rental income"),
    ]);
    const second = clusterFindings([
      finding("a", "Sargassum and coastal property risk"),
      finding("b", "Sargassum and beach quality risk to rental income"),
      finding("c", "Sargassum as a coastal rental/tourism risk"),
    ]);
    expect(second[0].key).toBe(first[0].key);
  });

  it("keeps every member so no evidence is lost", () => {
    const clusters = clusterFindings([
      finding("a", "Sargassum and coastal property risk"),
      finding("b", "Sargassum and beach quality risk to rental income"),
    ]);
    expect(clusters[0].members).toHaveLength(2);
  });
});
