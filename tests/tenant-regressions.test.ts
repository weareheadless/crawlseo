import { describe, expect, it } from "vitest";

import { documentMarkup } from "@/lib/crawler/engine";
import { isAssessedPage, isSchemaAbsence } from "@/lib/funnel/backfill";

/**
 * Cross-tenant regression fixtures (plan P8). Each case is a failure that reached a
 * live board, encoded so it cannot come back silently.
 */

const anchorsOf = (html: string): string[] =>
  [...documentMarkup(html).matchAll(/<a\b([^>]*)>/gi)]
    .map((m) => m[1].match(/href=["']([^"'#][^"']*)["']/i)?.[1] ?? "")
    .filter(Boolean);

describe("crawl extraction", () => {
  it("does not read a JavaScript template as a link (casamigo)", () => {
    // The live Cancun page builds its modal link inside a script.
    const html = `<html><body>
      <a href="/cities/tulum">Tulum</a>
      <script>
        const link = \`<a class="ci-webflow-modal__link" href="\${esc(url)}">Open</a>\`;
      </script>
    </body></html>`;
    expect(anchorsOf(html)).toEqual(["/cities/tulum"]);
  });

  it("still finds a real broken link in the markup", () => {
    expect(anchorsOf(`<p><a href="/missing-page">Gone</a></p>`)).toEqual(["/missing-page"]);
  });

  it("ignores commented-out and noscript markup", () => {
    const html = `<!-- <a href="/old">old</a> --><noscript><a href="/no-js">x</a></noscript><a href="/real">y</a>`;
    expect(anchorsOf(html)).toEqual(["/real"]);
  });

  it("keeps body text free of script source", () => {
    const html = `<p>Visible copy</p><script>const a = "not copy";</script>`;
    expect(documentMarkup(html)).not.toContain("not copy");
    expect(documentMarkup(html)).toContain("Visible copy");
  });
});

describe("crawl issue semantics", () => {
  it("does not turn an unavailable business audit into missing schema", () => {
    expect(isSchemaAbsence({ type: "MISSING_SCHEMA", details: { kind: "business_schema_semantics" } })).toBe(false);
    expect(isSchemaAbsence({ type: "MISSING_SCHEMA", details: { kind: "sitemap_coverage" } })).toBe(false);
    expect(isSchemaAbsence({ type: "MISSING_SCHEMA", details: { kind: "ai_crawler_block" } })).toBe(false);
    expect(isSchemaAbsence({ type: "MISSING_SCHEMA", details: { kind: "crawl_summary" } })).toBe(false);
  });

  it("keeps a real structured-data absence", () => {
    expect(isSchemaAbsence({ type: "MISSING_SCHEMA", details: { kind: "identity_jsonld_absence" } })).toBe(true);
    expect(isSchemaAbsence({ type: "INVALID_SCHEMA" })).toBe(true);
  });

  it("does not assess a challenge or an error as a page", () => {
    expect(isAssessedPage({ statusCode: 200, title: "Checking Your Request" })).toBe(false);
    expect(isAssessedPage({ statusCode: 200, title: "Just a moment..." })).toBe(false);
    expect(isAssessedPage({ statusCode: 429, title: "Too Many Requests" })).toBe(false);
    expect(isAssessedPage({ statusCode: 404, title: "Not Found" })).toBe(false);
    expect(isAssessedPage({ statusCode: 200, title: "Unique lampshades, made by hand" })).toBe(true);
  });
});
