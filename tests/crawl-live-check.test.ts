import { describe, expect, it } from "vitest";
import { auditSchemaSemantics, liveCheckFromHtml } from "@/lib/research/crawl-live-check";

const page = `<!doctype html><html><head>
<title>Example listing</title>
<meta name="description" content="A useful description">
<link rel="canonical" href="https://www.example.com/listing">
<script type="application/ld+json">{"@type":"Product"}</script>
</head><body>
<h1>Example listing</h1>
<img src="a.jpg" alt="A">
<img src="b.jpg">
</body></html>`;

describe("crawl live checks", () => {
  const knowledge = { fields: { businessName: { value: "Acme Ltd", publicationUse: "approved", provenance: { status: "owner_confirmed" } } } } as never;
  it("compares approved facts and returns stable evidence-backed mismatches", () => {
    const html = '<h1>Acme Ltd</h1><script type="application/ld+json">{"@type":"Organization","name":"Acme Ltd"}</script>';
    expect(auditSchemaSemantics(html, knowledge)).toEqual([]);
    const mismatch = '<h1>Wrong Co</h1><script type="application/ld+json">{"@type":"Organization","name":"Wrong Co"}</script>';
    const first = auditSchemaSemantics(mismatch, knowledge);
    expect(first.some(f => f.status === "mismatch" && f.evidence.includes("Acme Ltd"))).toBe(true);
    expect(auditSchemaSemantics(mismatch, knowledge)).toEqual(first);
  });
  it("reports missing structured data and unavailable inputs as unknown", () => {
    expect(auditSchemaSemantics("<h1>Acme Ltd</h1>", knowledge)[0].status).toBe("unknown");
    expect(auditSchemaSemantics(null, knowledge)[0].status).toBe("unknown");
  });
  it("reproduces H1, title, description, canonical, schema, and alt checks", () => {
    expect(liveCheckFromHtml("MISSING_H1", page).issue_reproduced).toBe(false);
    expect(liveCheckFromHtml("MULTIPLE_H1", page).issue_reproduced).toBe(false);
    expect(liveCheckFromHtml("MISSING_TITLE", page).issue_reproduced).toBe(false);
    expect(liveCheckFromHtml("MISSING_DESCRIPTION", page).issue_reproduced).toBe(false);
    expect(liveCheckFromHtml("MISSING_CANONICAL", page).issue_reproduced).toBe(false);
    expect(liveCheckFromHtml("MISSING_SCHEMA", page).issue_reproduced).toBe(false);
    expect(liveCheckFromHtml("MISSING_ALT", page).issue_reproduced).toBe(true);
    expect(liveCheckFromHtml("MISSING_ALT", page).images_missing_alt).toBe(1);
  });

  it("detects a page where the issue still reproduces", () => {
    const empty = "<html><head><title></title></head><body></body></html>";
    expect(liveCheckFromHtml("MISSING_H1", empty).issue_reproduced).toBe(true);
    expect(liveCheckFromHtml("MISSING_TITLE", empty).issue_reproduced).toBe(true);
    expect(liveCheckFromHtml("MISSING_DESCRIPTION", empty).issue_reproduced).toBe(true);
    expect(liveCheckFromHtml("MISSING_CANONICAL", empty).issue_reproduced).toBe(true);
    expect(liveCheckFromHtml("MISSING_SCHEMA", empty).issue_reproduced).toBe(true);
  });
});
