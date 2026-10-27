import type { CrawlActionDraft } from "@/lib/research/crawl-actions";
import type { BusinessKnowledgeDocument, BusinessKnowledgeFields } from "@/lib/projects/business-knowledge";

export type SchemaSemanticsFinding = { code: string; field: string; status: "mismatch" | "unknown"; expected?: string; observed?: string; evidence: string; key: string; location?: string };
export type SchemaAuditProjection = { visibleText: string; jsonLdBlocks: string[] };

/** Keep only bounded evidence needed by the audit; never retain a crawled document. */
export function schemaAuditProjection(html: string | null | undefined): SchemaAuditProjection | null {
  if (!html) return null;
  const jsonLdBlocks: string[] = [];
  const re = /<script\b(?=[^>]*type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;
  let block: RegExpExecArray | null;
  let remaining = 20_000;
  while ((block = re.exec(html)) && remaining > 0 && jsonLdBlocks.length < 8) {
    const text = block[1].slice(0, remaining);
    jsonLdBlocks.push(text);
    remaining -= text.length;
  }
  const visibleText = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim().slice(0, 4000);
  return { visibleText, jsonLdBlocks };
}

/** Detect-only comparison of approved business facts with page-visible text and JSON-LD. */
export function auditSchemaSemantics(input: string | SchemaAuditProjection | null | undefined, knowledge: BusinessKnowledgeDocument | null | undefined): SchemaSemanticsFinding[] {
  const projection = typeof input === "string" ? schemaAuditProjection(input) : input;
  if (!projection || !knowledge) return [{ code: "AUDIT_INPUT_UNAVAILABLE", field: "page/businessKnowledge", status: "unknown", evidence: !projection ? "Published page HTML is unavailable" : "Canonical business knowledge is unavailable", key: "AUDIT_INPUT_UNAVAILABLE:page/businessKnowledge", location: !projection ? "page HTML" : "business knowledge API" }];
  const visible = projection.visibleText;
  const blocks: unknown[] = [];
  for (const block of projection.jsonLdBlocks) { try { const parsed: unknown = JSON.parse(block); blocks.push(...(Array.isArray(parsed) ? parsed : [parsed])); } catch { return [{ code: "INVALID_JSONLD", field: "structuredData", status: "unknown", evidence: "A JSON-LD block could not be parsed", key: "INVALID_JSONLD:structuredData" }]; } }
  if (!blocks.length) return [{ code: "STRUCTURED_DATA_MISSING", field: "structuredData", status: "unknown", evidence: "No JSON-LD structured data was present to compare", key: "STRUCTURED_DATA_MISSING:structuredData" }];
  const flatten = (item: unknown): Record<string, unknown>[] => {
    if (!item || typeof item !== "object") return [];
    const obj = item as Record<string, unknown>;
    return [...(Array.isArray(obj["@graph"]) ? obj["@graph"].flatMap(flatten) : []), obj];
  };
  const nodes = blocks.flatMap(flatten);
  const mappings: Array<[keyof BusinessKnowledgeFields, string, string]> = [["businessName", "name", "name"], ["location", "address", "address"]];
  const findings: SchemaSemanticsFinding[] = [];
  const valueText = (v: unknown): string => typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : "";
  for (const [field, schemaKey, label] of mappings) {
    const fact = knowledge.fields[field];
    if (!fact) continue;
    if (fact.publicationUse !== "approved" || !["owner_confirmed", "admin_confirmed", "verified"].includes(fact.provenance.status)) {
      findings.push({ code: "BUSINESS_FACT_NOT_PUBLISHABLE", field, status: "unknown", evidence: `Canonical ${field} is not approved for publication`, key: `BUSINESS_FACT_NOT_PUBLISHABLE:${field}`, location: "canonical business knowledge" }); continue;
    }
    const expected = Array.isArray(fact.value) ? fact.value.join(", ") : fact.value;
    for (const [representation, observed] of [["visible", visible], ["structuredData", nodes.map(n => valueText(n[schemaKey])).join(" ")]] as const) {
      if (!observed) { findings.push({ code: "REPRESENTATION_UNREADABLE", field, status: "unknown", evidence: `${representation} value for ${label} is unavailable`, key: `REPRESENTATION_UNREADABLE:${field}:${representation}`, location: representation }); continue; }
      if (!observed.toLocaleLowerCase().includes(expected.toLocaleLowerCase())) findings.push({ code: "BUSINESS_CONTENT_MISMATCH", field, status: "mismatch", expected, observed: observed.slice(0, 240), evidence: `${representation} did not contain the canonical approved ${label} (${expected})`, key: `BUSINESS_CONTENT_MISMATCH:${field}:${representation}`, location: representation });
    }
  }
  return findings;
}

const LIVE_CHECKABLE = new Set([
  "MISSING_H1",
  "MULTIPLE_H1",
  "MISSING_TITLE",
  "MISSING_DESCRIPTION",
  "MISSING_CANONICAL",
  "MISSING_SCHEMA",
  "MISSING_ALT",
]);
const LIVE_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export type CrawlLiveCheck = {
  checked_at: string;
  status: number | null;
  issue_type: string;
  issue_reproduced: boolean | null;
  h1_count?: number | null;
  title_present?: boolean;
  description_present?: boolean;
  canonical_present?: boolean;
  schema_present?: boolean;
  images_missing_alt?: number;
  image_count?: number;
  reproduced_url?: string | null;
  checked_urls?: string[];
  reason?: string;
};

function extractTag(html: string, pattern: RegExp): string | null {
  return html.match(pattern)?.[1]?.trim() || null;
}

export function liveCheckFromHtml(issueType: string, html: string): Omit<CrawlLiveCheck, "checked_at" | "status" | "issue_type"> {
  const h1Count = [...html.matchAll(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi)].length;
  const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = extractTag(
    html,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  ) || extractTag(
    html,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
  );
  const canonical = extractTag(
    html,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
  ) || extractTag(
    html,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
  );
  const hasSchema = /application\/ld\+json/i.test(html)
    || /\bitemscope\b/i.test(html)
    || /\bitemtype\b/i.test(html);
  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const imagesMissingAlt = imgTags.filter((tag) => !/\balt\s*=\s*["'][^"']+["']/i.test(tag)).length;

  let issueReproduced: boolean | null = null;
  if (issueType === "MISSING_H1") issueReproduced = h1Count === 0;
  else if (issueType === "MULTIPLE_H1") issueReproduced = h1Count > 1;
  else if (issueType === "MISSING_TITLE") issueReproduced = !title;
  else if (issueType === "MISSING_DESCRIPTION") issueReproduced = !description;
  else if (issueType === "MISSING_CANONICAL") issueReproduced = !canonical;
  else if (issueType === "MISSING_SCHEMA") issueReproduced = !hasSchema;
  else if (issueType === "MISSING_ALT") issueReproduced = imagesMissingAlt > 0;

  return {
    h1_count: h1Count,
    title_present: Boolean(title),
    description_present: Boolean(description),
    canonical_present: Boolean(canonical),
    schema_present: hasSchema,
    images_missing_alt: imagesMissingAlt,
    image_count: imgTags.length,
    issue_reproduced: issueReproduced,
  };
}

export async function verifyCrawlDraftLive(
  draft: CrawlActionDraft,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<CrawlLiveCheck | null> {
  if (!LIVE_CHECKABLE.has(draft.issueType)) return null;
  const checkedAt = new Date().toISOString();
  const evidenceUrls = Array.isArray(draft.evidence.urls)
    ? draft.evidence.urls.filter((url): url is string => typeof url === "string")
    : [];
  const urls = draft.evidence.batch === true
    ? [...new Set([draft.targetUrl, ...evidenceUrls])].slice(0, 6)
    : [draft.targetUrl];
  let unverified: CrawlLiveCheck | null = null;

  for (const url of urls) {
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        redirect: "follow",
        headers: {
          "User-Agent": LIVE_UA,
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        unverified ??= {
          checked_at: checkedAt,
          status: response.status,
          issue_type: draft.issueType,
          issue_reproduced: null,
          reproduced_url: null,
          checked_urls: urls,
          reason: `Live page returned HTTP ${response.status} for ${url}`,
        };
        continue;
      }
      const html = await response.text();
      const check = liveCheckFromHtml(draft.issueType, html);
      if (check.issue_reproduced === true) {
        return {
          checked_at: checkedAt,
          status: response.status,
          issue_type: draft.issueType,
          reproduced_url: url,
          checked_urls: urls,
          ...check,
        };
      }
      if (check.issue_reproduced === null) {
        unverified ??= {
          checked_at: checkedAt,
          status: response.status,
          issue_type: draft.issueType,
          reproduced_url: null,
          checked_urls: urls,
          ...check,
        };
      }
    } catch (error) {
      unverified ??= {
        checked_at: checkedAt,
        status: null,
        issue_type: draft.issueType,
        issue_reproduced: null,
        reproduced_url: null,
        checked_urls: urls,
        reason: error instanceof Error ? error.message.slice(0, 200) : "Live check failed",
      };
    }
  }

  if (unverified) return unverified;
  return {
    checked_at: checkedAt,
    status: 200,
    issue_type: draft.issueType,
    issue_reproduced: false,
    reproduced_url: null,
    checked_urls: urls,
  };
}
