import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { createResearchAction } from "@/lib/research/service";
import { getPrelaunchReport } from "@/lib/dataforseo/prelaunch-report";

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const identity = (s: string) => createHash("sha256").update(norm(s)).digest("hex").slice(0, 32);
export async function derivePrelaunchActions(projectId: string, runId: string) {
  const run = await db.seoResearchRun.findFirst({ where: { id: runId, projectId, siteId: null }, include: { tasks: true } });
  if (!run) throw new Error("PRELAUNCH_RESEARCH_NOT_FOUND");
  const site = await db.site.findFirst({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!site) return { created: 0, existing: 0, reason: "No project site is available for Work Actions." };
  const gsc = await db.syncRun.findFirst({ where: { siteId: site.id, source: "GSC", status: "COMPLETED" }, select: { id: true } });
  const report = await getPrelaunchReport(projectId, runId); if (!report) throw new Error("PRELAUNCH_RESEARCH_NOT_FOUND");
  const seeds = run.tasks.filter((t) => t.kind === "KEYWORD_SEED" && t.status === "COMPLETED").flatMap((t) => {
    const input = t.input && typeof t.input === "object" ? t.input as Record<string, unknown> : {};
    const seed = typeof input.seed === "string" ? input.seed : null;
    return seed ? [{ seed, rows: report.tasks.find((v) => v.id === t.id)?.keywords ?? [] }] : [];
  });
  let created = 0, existing = 0;
  const byIntent = new Map<string, string[]>();
  for (const { seed, rows } of seeds) for (const row of rows) {
    const intent = row.intent !== "Unknown" ? row.intent : null;
    if (intent) byIntent.set(intent.toLowerCase(), [...(byIntent.get(intent.toLowerCase()) ?? []), seed]);
    const volume = Number(row.volume);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    if (!gsc) continue;
    const ranked = await db.keyword.findFirst({ where: { siteId: site.id, query: { equals: seed, mode: "insensitive" }, impressions: { gt: 0 } }, select: { id: true } });
    if (ranked) continue;
    const key = `prelaunch:${projectId}:content:${identity(seed)}`;
    const result = await createResearchAction(site.id, { source: "keyword_research", kind: "create_content", format: "page_update", title: `Create content for ${seed}`, primaryQuery: seed,
      recommendation: `Create or update a page targeting “${seed}”. Stored keyword research reports volume ${volume}; ranking-page status is based on the site's available Search Console keyword rows.`, priority: 60, automationMode: "MANUAL", dedupeKey: key,
      evidence: { kind: "prelaunch_keyword", research_run_id: runId, project_id: projectId, seed, volume, verifier: { type: "gsc_keyword_page_present", keyword: seed, check: "An imported Search Console row for this query with impressions greater than zero proves that a ranking page is recorded." } } }, "system:prelaunch-research");
    result.created ? created++ : existing++;
  }
  for (const [intent, matching] of byIntent) {
    const pair = [...new Set(matching.map(norm))].sort(); if (pair.length < 2) continue;
    const keyPart = pair.join("|");
    const result = await createResearchAction(site.id, { source: "keyword_research", kind: "consolidate_content", format: "page_update", title: `Consolidate pages targeting ${intent} intent`, primaryQuery: pair.join(" / "),
      recommendation: `Review whether the pages targeting ${pair.map((s) => `“${s}”`).join(" and ")} should be consolidated. Both seeds share the provider-reported intent; choose the canonical page after review.`, priority: 55, automationMode: "MANUAL", dedupeKey: `prelaunch:${projectId}:intent:${identity(keyPart)}`,
      evidence: { kind: "prelaunch_keyword_intent", research_run_id: runId, project_id: projectId, intent, seeds: pair, verifier: { type: "canonical_page_for_intent", intent, seeds: pair, check: "Verify the selected canonical page serves the shared intent and the alternate page is appropriately consolidated or redirected." } } }, "system:prelaunch-research");
    result.created ? created++ : existing++;
  }
  return { created, existing, ...(gsc ? {} : { reason: "No completed Search Console sync is available; ranking-page absence is unknown, so content Actions were not inferred." }) };
}
