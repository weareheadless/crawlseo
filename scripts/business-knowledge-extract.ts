/**
 * Business knowledge extraction from the live site.
 *
 * Reads a handful of crawled/live pages, asks the content model for the canonical
 * fields, and writes them as a **working** revision with `ai_observation`
 * provenance and status `assumed`, publicationUse `internal_only`.
 *
 * That is deliberately not owner-confirmed: it gives the funnel a why leg it can
 * cite, while the document still says "nobody verified this". Acceptance stays the
 * owner's call through the existing acceptance service.
 *
 *   npx tsx scripts/business-knowledge-extract.ts --project <projectId> [--dry-run]
 */

import { createHash } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { writeBusinessKnowledge } from "@/lib/projects/business-knowledge";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { chatJson } from "@/lib/ai/chat";

const MAX_PAGES = 10;
const MAX_CHARS_PER_PAGE = 6_000;

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const dryRun = argv.includes("--dry-run");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--dry-run") continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(arg.slice(2), value);
    i += 1;
  }
  const projectId = values.get("project");
  if (!projectId) throw new Error("--project <projectId> is required");
  return { projectId, dryRun };
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPage(url: string): Promise<{ url: string; text: string; title: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "CrawlSEO business knowledge extractor (+https://crawlseo.app)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    return { url: res.url || url, text: htmlToText(html).slice(0, MAX_CHARS_PER_PAGE), title };
  } catch {
    return null;
  }
}

type Extracted = {
  businessName?: string;
  services?: string[];
  location?: string;
  serviceArea?: string[];
  differentiators?: string[];
  audienceMotivations?: string[];
  concerns?: string[];
  conversionGoals?: string[];
  voice?: string;
};

const SYSTEM = `Tu extrais la connaissance metier d'un site web pour un document d'entreprise.
Reponds uniquement en JSON avec les cles: businessName (texte), services (liste), location (texte),
serviceArea (liste), differentiators (liste), audienceMotivations (liste), concerns (liste),
conversionGoals (liste), voice (texte).
Regles: n'invente rien. Si une information n'apparait pas explicitement sur les pages, omets la cle.
Les valeurs doivent etre courtes, factuelles, en francais, et citees telles quelles quand c'est un nom.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();

  const project = await db.project.findUniqueOrThrow({
    where: { id: args.projectId },
    select: { id: true, workspaceId: true, name: true, sites: { select: { id: true, domain: true }, take: 1, orderBy: { createdAt: "asc" } } },
  });
  const site = project.sites[0];
  if (!site) throw new Error("project has no site");

  // Crawled pages, by traffic, then the site root. The crawl already knows which
  // URLs matter, so extraction reads the same pages the funnel scores.
  const crawlEvidence = await db.evidenceRecord.findMany({
    where: { projectId: project.id, kind: "gsc_page", supersededById: null },
    select: { dimensions: true, metrics: true },
  });
  const ranked = crawlEvidence
    .map((row) => ({
      url: (row.dimensions as { url?: string } | null)?.url ?? "",
      impressions: Number((row.metrics as Record<string, { value?: number }> | null)?.["first_party:impressions"]?.value ?? 0),
    }))
    .filter((row) => row.url)
    .sort((a, b) => b.impressions - a.impressions)
    .map((row) => row.url);
  // Traffic pages alone miss service sections that rarely rank (tapisserie was
  // absent from the extracted services because its page was not fetched). Add one
  // representative per top-level path from the sitemap.
  const origin = `https://${site.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const sitemapSections: string[] = [];
  try {
    const xml = await (await fetch(`${origin}/sitemap.xml`, { signal: AbortSignal.timeout(15_000) })).text();
    const locs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => match[1].trim());
    const seen = new Set<string>();
    for (const loc of locs) {
      const path = new URL(loc).pathname.replace(/^\/+/, "");
      const section = path.split("/")[0] || "/";
      if (seen.has(section)) continue;
      seen.add(section);
      sitemapSections.push(loc);
    }
  } catch {
    // No sitemap: traffic pages and the root are still enough to start.
  }
  const urls = [...new Set([`${origin}/`, ...ranked, ...sitemapSections])].slice(0, MAX_PAGES);

  const pages: Array<{ url: string; text: string; title: string }> = [];
  for (const url of urls) {
    const page = await fetchPage(url);
    if (page) pages.push(page);
  }
  if (pages.length === 0) throw new Error("no page could be fetched");
  process.stdout.write(`read ${pages.length} pages: ${pages.map((p) => p.url).join(", ")}\n`);

  const config = contentWriterConfig();
  if (!config) throw new Error("CONTENT_LLM_API_KEY is not configured");

  const userPrompt = pages
    .map((page, index) => `--- PAGE ${index + 1}: ${page.url}\nTITLE: ${page.title}\n${page.text}`)
    .join("\n\n");

  let parsed: Extracted;
  try {
    parsed = (await chatJson({
      config,
      system: SYSTEM,
      user: userPrompt,
      maxTokens: 3_000,
      attempts: 4,
    })) as Extracted;
  } catch (error) {
    throw new Error(`content model failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const extracted = parsed;

  const sourceUrl = pages[0].url;
  const now = new Date().toISOString();
  const provenance = {
    kind: "ai_observation" as const,
    sourceId: "crawler-extractor",
    originSystem: "crawlseo",
    // The identifier schema forbids slashes; the full URL stays in evidenceUri.
    originRecordId: createHash("sha256").update(sourceUrl).digest("hex").slice(0, 32),
    originRevision: null,
    actor: { type: "model" as const, id: "crawler-extractor" },
    status: "assumed" as const,
    recordedAt: now,
    observedAt: now,
    evidenceUri: sourceUrl,
  };
  const fact = (value: string | string[] | undefined, locale?: string) => {
    if (value === undefined) return undefined;
    const clean = Array.isArray(value)
      ? value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 30)
      : String(value).trim();
    if (Array.isArray(clean) ? clean.length === 0 : clean.length === 0) return undefined;
    return {
      value: clean,
      provenance,
      publicationUse: "internal_only" as const,
      ...(locale ? { locale } : {}),
    };
  };

  const changes = Object.fromEntries(
    Object.entries({
      businessName: fact(extracted.businessName),
      services: fact(extracted.services),
      location: fact(extracted.location),
      serviceArea: fact(extracted.serviceArea),
      differentiators: fact(extracted.differentiators),
      audienceMotivations: fact(extracted.audienceMotivations),
      concerns: fact(extracted.concerns),
      conversionGoals: fact(extracted.conversionGoals),
      voice: fact(extracted.voice),
    }).filter(([, value]) => value !== undefined)
  );

  process.stdout.write(JSON.stringify({ extracted: Object.keys(changes), dryRun: args.dryRun }, null, 1) + "\n");
  if (args.dryRun) {
    await db.$disconnect();
    return;
  }

  const head = await db.businessKnowledgeDocument.findUnique({ where: { projectId: project.id }, select: { logicalId: true, revision: true } });
  const documentId = head?.logicalId ?? `business-${project.id}`;
  const result = await writeBusinessKnowledge(
    {
      workspaceId: project.workspaceId,
      projectId: project.id,
      documentId,
      expectedRevision: head?.revision ?? 0,
      idempotencyKey: `crawler-extract:${project.id}:${now}`,
      reason: "Extracted from the live site by the crawler extractor; unverified",
      changes,
    },
    {
      credentialId: "internal-extractor",
      servicePrincipalId: "crawler-extractor",
      workspaceId: project.workspaceId,
      projectId: project.id,
      scopes: ["document:write"],
    }
  );

  process.stdout.write(JSON.stringify({ documentId: result.documentId, revision: result.revision, state: result.state, fields: Object.keys(changes).length }, null, 1) + "\n");
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
