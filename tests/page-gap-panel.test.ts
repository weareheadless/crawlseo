import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { PageGapPanel } from "@/components/funnel/page-gap-panel";
import { pageGap, type PageProfile } from "@/lib/funnel/page-gap";

/**
 * CMP-006's visible half.
 *
 * The acceptance requires the opportunity to show the competitor URLs with their
 * profile, name a concrete deficit where one exists, say "no measurable deficit"
 * when none does, and record an unreadable page with its reason.
 */

type Node = ReactElement<Record<string, unknown>>;

function textOf(node: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isValidElement(value)) return;
    visit((value as Node).props.children);
  };
  visit(node);
  return parts.join(" ");
}

const now = new Date("2026-11-24T00:00:00Z");

function page(over: Partial<PageProfile> = {}): PageProfile {
  return {
    url: "https://rival.com/x",
    domain: "rival.com",
    position: 2,
    title: "t",
    wordCount: 1840,
    h1Count: 1,
    headings: ["What is it", "How much"],
    hasSchema: true,
    schemaTypes: ["Product"],
    internalLinks: 20,
    lastModified: null,
    fetchedAt: now,
    ...over,
  };
}

const ours = page({ url: "https://site.com/ours", domain: "site.com", position: 9, wordCount: 420, headings: ["A"], schemaTypes: [], hasSchema: false });

describe("CMP-006 gap panel", () => {
  it("lists a competitor with its word count, headings, schema and read date", () => {
    const gap = pageGap({ ours, competitors: [page()], now });
    const text = textOf(PageGapPanel({ gap }));
    expect(text).toContain("rival.com");
    expect(text).toContain("1,840");
    expect(text).toContain("Product");
    expect(text).toContain("read 2026-11-24");
  });

  it("shows our own page beside theirs", () => {
    const gap = pageGap({ ours, competitors: [page()], now });
    const text = textOf(PageGapPanel({ gap }));
    expect(text).toContain("ours");
    expect(text).toContain("420");
  });

  it("names the concrete deficit", () => {
    const gap = pageGap({ ours, competitors: [page()], now });
    const text = textOf(PageGapPanel({ gap }));
    expect(text).toContain("What they have that we do not");
    expect(text).toContain("median of 1,840 words");
  });

  it("says no measurable deficit rather than showing nothing", () => {
    const strong = page({ wordCount: 3000, headings: ["A", "B", "C"], schemaTypes: ["Product"] });
    const gap = pageGap({ ours: strong, competitors: [page({ wordCount: 400, headings: ["A"], schemaTypes: [] })], now });
    const text = textOf(PageGapPanel({ gap }));
    expect(text).toContain("No measurable deficit");
    expect(text).toContain("not a content gap");
  });

  it("records an unreadable competitor with its reason", () => {
    const gap = pageGap({
      ours,
      competitors: [page(), page({ url: "https://waf.test/", domain: "waf.test", unreadable: "HTTP 403" })],
      now,
    });
    const text = textOf(PageGapPanel({ gap }));
    expect(text).toContain("Could not be read");
    expect(text).toContain("HTTP 403");
    // The readable one is still compared.
    expect(text).toContain("1,840");
  });

  it("states why page strength is not in the score", () => {
    const gap = pageGap({ ours: null, competitors: [page()], now });
    const text = textOf(PageGapPanel({ gap }));
    expect(text).toContain("Page strength is not used in this score");
    expect(text).toContain("has not been crawled");
  });
});
