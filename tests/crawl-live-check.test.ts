import { describe, expect, it } from "vitest";
import { auditSchemaSemantics, liveCheckFromHtml } from "@/lib/research/crawl-live-check";
import { persistSchemaSemanticsIssues } from "@/lib/crawler/schema-semantics-persistence";

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
  it("persists evidence, stays idempotent, and updates changed results", async () => {
    const rows = new Map<string, { id: string; data: Record<string, unknown> }>();
    const store = { crawlIssue: {
      findFirst: async ({ where }: { where: { details: { equals: string } } }) => rows.get(where.details.equals) ? { id: rows.get(where.details.equals)!.id } : null,
      findMany: async () => [...rows.values()].map(row => ({ id: row.id, details: row.data.details })),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => { for (const [key, row] of rows) if (where.id.in.includes(row.id)) rows.delete(key); },
      create: async ({ data }: { data: Record<string, unknown> }) => { const details = data.details as Record<string, unknown>; rows.set(String(details.stableKey), { id: `issue-${rows.size}`, data }); },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { for (const [key, row] of rows) if (row.id === where.id) rows.set(key, { ...row, data }); },
    } } as never;
    const html = '<h1>Wrong Co</h1><script type="application/ld+json">{"@type":"Organization","name":"Wrong Co"}</script>';
    const findings = auditSchemaSemantics(html, knowledge);
    const issue = { url: "https://example.com/", severity: "WARNING" as const, message: "Mismatch", details: { stableKey: "page:field", field: "businessName", knowledgeDocumentId: "doc1", knowledgeRevision: 2, evidence: findings[0]?.evidence } };
    await persistSchemaSemanticsIssues(store, "crawl-1", [issue]);
    await persistSchemaSemanticsIssues(store, "crawl-1", [issue]);
    expect(rows.size).toBe(1);
    await persistSchemaSemanticsIssues(store, "crawl-1", [{ ...issue, details: { ...issue.details, knowledgeRevision: 3, observed: "Different" } }]);
    expect(rows.size).toBe(1);
    expect(rows.get("page:field")?.data.details).toMatchObject({ knowledgeRevision: 3, observed: "Different", field: "businessName" });
    await persistSchemaSemanticsIssues(store, "crawl-1", []);
    expect(rows.size).toBe(0);
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
