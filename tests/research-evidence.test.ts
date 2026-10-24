import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceList } from "@/components/research/source-evidence";
import {
  isSafeHttpUrl,
  jsonStringArray,
  keywordEvidenceForAction,
  selectEvidenceSources,
  sourceHost,
  sourceIdsForAction,
  sourceProviderLabel,
  sourcePublisher,
} from "@/lib/research/evidence";

describe("research evidence", () => {
  it("prefers finding citations over the action source list", () => {
    expect(sourceIdsForAction({
      evidence: { source_ids: ["all-1", "all-2"] },
      finding: { evidenceSourceIds: ["cited-1"] },
    })).toEqual(["cited-1"]);
  });

  it("falls back to evidence source ids when no finding is linked", () => {
    expect(sourceIdsForAction({
      evidence: { source_ids: ["source-1", "source-2"] },
      finding: null,
    })).toEqual(["source-1", "source-2"]);
  });

  it("deduplicates and preserves citation order", () => {
    const sources = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ];
    expect(selectEvidenceSources(sources, ["c", "a", "c", "missing"])).toEqual([
      { id: "c", title: "C" },
      { id: "a", title: "A" },
    ]);
  });

  it("normalizes string arrays and rejects non-http links", () => {
    expect(jsonStringArray(["a", "", "a", 4, null])).toEqual(["a"]);
    expect(isSafeHttpUrl("https://example.com/source")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("not a url")).toBe(false);
  });

  it("uses publisher metadata before community labels", () => {
    expect(sourcePublisher({
      provider: "google_news_rss",
      metadata: { publisher: "Reuters" },
    })).toBe("Reuters");
    expect(sourcePublisher({
      provider: "reddit_rss",
      community: "r/tulum",
    })).toBe("r/tulum");
    expect(sourceProviderLabel("google_news_rss")).toBe("Google News RSS");
    expect(sourceHost("https://www.example.com/path")).toBe("example.com");
  });
});

describe("source evidence UI", () => {
  it("renders clickable original links and the stored excerpt", () => {
    const html = renderToStaticMarkup(createElement(SourceList, {
      sources: [{
        id: "source-1",
        provider: "google_news_rss",
        url: "https://example.com/article",
        title: "Example article",
        author: null,
        community: null,
        publishedAt: "2026-10-01T00:00:00.000Z",
        retrievedAt: "2026-10-02T00:00:00.000Z",
        excerpt: "A stored excerpt used as evidence.",
        metadata: { publisher: "Example Publisher" },
      }],
      title: "Evidence sources",
    }));

    expect(html).toContain('href="https://example.com/article"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("A stored excerpt used as evidence.");
    expect(html).toContain("Example Publisher");
  });
});

describe("keyword evidence", () => {
  it("extracts keyword demand attached to an action", () => {
    expect(keywordEvidenceForAction({
      keyword_research: {
        keyword: "hospital near me",
        volume: 1000,
        difficulty: 40,
        cpc: 1.2,
        competition: 0.4,
        intent: "local",
        queued_at: "2026-10-23T19:16:57.104Z",
      },
    })).toEqual({
      keyword: "hospital near me",
      volume: 1000,
      difficulty: 40,
      cpc: 1.2,
      competition: 0.4,
      intent: "local",
      queuedAt: "2026-10-23T19:16:57.104Z",
    });
  });

  it("returns null when no keyword research is attached", () => {
    expect(keywordEvidenceForAction({ metrics: { impressions: 100 } })).toBeNull();
  });
});
