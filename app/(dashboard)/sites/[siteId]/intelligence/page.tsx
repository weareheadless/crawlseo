import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { observedCount, visibilityState } from "@/lib/research/intelligence-view";

export default async function IntelligencePage({ params }: { params: Promise<{ siteId: string }> }) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, userId: true, projectId: true, domain: true } });
  if (!site) redirect("/sites");
  const projectId = site.projectId;
  const [crawl, observations, coverages, sources] = await Promise.all([
    db.crawl.findFirst({ where: { siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true, issues: { select: { type: true, details: true } } } }),
    projectId ? db.aIVisibilityObservation.findMany({ where: { projectId }, orderBy: [{ observedAt: "desc" }, { provider: "asc" }, { modelSurface: "asc" }], take: 200 }) : Promise.resolve([]),
    projectId ? db.questionCoverage.findMany({ where: { projectId }, include: { finding: { select: { summary: true } }, action: { select: { id: true, title: true } }, document: { select: { logicalId: true } } }, orderBy: { updatedAt: "desc" }, take: 200 }) : Promise.resolve([]),
    projectId ? db.researchSource.findMany({ where: { run: { projectId } }, select: { id: true, provider: true, url: true, title: true, retrievedAt: true, identityId: true }, orderBy: { retrievedAt: "desc" }, take: 200 }) : Promise.resolve([]),
  ]);
  const robotsIssue = crawl?.issues.some((issue) => issue.type === "MISSING_ROBOTS" || (issue.details as { kind?: string } | null)?.kind === "ai_crawler_block");
  const sitemapIssue = crawl?.issues.some((issue) => issue.type === "MISSING_SITEMAP");
  const grouped = new Map<string, typeof observations>();
  for (const observation of observations) {
    const key = `${observation.provider} · ${observation.modelSurface}`;
    grouped.set(key, [...(grouped.get(key) ?? []), observation]);
  }

  return <div className="space-y-6">
    <PageHeader eyebrow={site.domain} title="Intelligence" description="Evidence about AI access, observed answer-engine visibility, question coverage and research sources. Access does not imply visibility." />
    <section className="panel p-4 sm:p-5"><h2 className="font-heading text-lg font-semibold">AI access readiness</h2><p className="mt-1 text-sm text-muted-foreground">Technical access signals from the latest completed crawl. These do not measure whether AI answers mention your site.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">{[{ label: "Robots / AI crawlers", value: !crawl ? "Unknown — crawl evidence unavailable" : robotsIssue ? "Potential restriction found" : "No blocking issue found" }, { label: "Sitemap", value: !crawl ? "Unknown — crawl evidence unavailable" : sitemapIssue ? "Not found by crawl" : "No missing-sitemap issue found" }, { label: "HTTP reachability", value: crawl ? "Site pages responded during crawl" : "Unknown — run a crawl" }].map(({ label, value }) => <div key={label} className="rounded-lg bg-muted/30 p-3"><p className="text-xs font-medium">{label}</p><p className="mt-1 text-sm">{value}</p><p className="mt-1 text-xs text-muted-foreground">{crawl?.finishedAt ? `Crawl evidence · ${crawl.finishedAt.toLocaleString()}` : "No dated evidence"}</p></div>)}</div>
      {!crawl && <p className="mt-3 text-sm text-muted-foreground">Run a site crawl to populate these access checks.</p>}
    </section>
    <section className="panel p-4 sm:p-5"><h2 className="font-heading text-lg font-semibold">Visibility observed</h2><p className="mt-1 text-sm text-muted-foreground">Imported observations only; each denominator and count comes from its provider export.</p>
      {grouped.size === 0 ? <Empty title="Nothing observed yet" text="Visibility is unknown until an authorized provider export is imported. Import an AI visibility export to populate these results; crawl access cannot substitute for an observation." /> : <div className="mt-4 space-y-3">{[...grouped].map(([surface, rows]) => <div key={surface} className="rounded-lg border border-border/60 p-3"><h3 className="font-medium">{surface}</h3>{rows.map((row) => <div key={row.id} className="mt-3 border-t border-border/40 pt-3 text-sm"><p className="font-medium">{row.question}</p><p className="mt-1 text-xs text-muted-foreground">Question set {row.questionSetVersion} · observed {row.observedAt.toLocaleDateString()} · denominator {row.denominator} (provider-reported)</p><p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">{[{ label: "Mentions", value: row.mentions }, { label: "Recommendations", value: row.recommendations }, { label: "Citations", value: row.citations }].map(({ label, value }) => <span key={label}>{label}: {visibilityState(row.coverage) === "Unknown" ? "Unknown" : observedCount(value)}</span>)}</p><p className="mt-1 text-xs text-muted-foreground">{visibilityState(row.coverage)}{visibilityState(row.coverage) === "Unknown" ? " — provider did not supply an observed answer; this is not zero." : ` · provider export v${row.version}`}</p></div>)}</div>)}</div>}
    </section>
    <section className="panel p-4 sm:p-5"><h2 className="font-heading text-lg font-semibold">Questions</h2><p className="mt-1 text-sm text-muted-foreground">Research questions and the recorded evidence status for their content section.</p>
      {coverages.length === 0 ? <Empty title="No question coverage recorded" text="Coverage appears when research findings are evaluated against confirmed knowledge and content sections. Start a research run to create questions and coverage work." /> : <div className="mt-3 divide-y divide-border/50">{coverages.map((coverage) => <article key={coverage.id} className="py-3"><p className="font-medium">{coverage.finding.summary}</p><p className="mt-1 break-all text-xs text-muted-foreground">{coverage.status === "COVERED" ? `Covered · field ${coverage.fieldPath ?? "unknown"} · revision ${coverage.evidenceRevision ?? "unknown"} · section hash ${coverage.contentHash}` : `Unresolved · ${coverage.missingEvidence ?? "Missing evidence not specified"}`}</p>{coverage.document && <p className="mt-1 text-xs text-muted-foreground">Knowledge document {coverage.document.logicalId}</p>}{coverage.action ? <Link className="mt-2 inline-block text-sm text-primary underline underline-offset-2" href={`/sites/${siteId}/actions/${coverage.action.id}`}>Action: {coverage.action.title}</Link> : coverage.status === "UNRESOLVED" ? <p className="mt-2 text-xs text-muted-foreground">No linked Action is recorded.</p> : null}</article>)}</div>}
    </section>
    <section className="panel p-4 sm:p-5"><h2 className="font-heading text-lg font-semibold">Sources</h2><p className="mt-1 text-sm text-muted-foreground">Research sources associated with this site’s findings.</p>
      {sources.length === 0 ? <Empty title="No research sources yet" text="Sources are recorded when a research run retrieves evidence. Configure research and start a run to populate this list." /> : <div className="mt-3 divide-y divide-border/50">{sources.map((source) => <article key={source.id} className="py-3"><p className="break-words font-medium">{source.title || source.url}</p><p className="mt-1 text-xs text-muted-foreground">{source.provider} · retrieved {source.retrievedAt.toLocaleString()} · {source.identityId ? "Reusable source identity recorded" : "No reuse identity recorded"}</p></article>)}</div>}
    </section>
  </div>;
}

function Empty({ title, text }: { title: string; text: string }) { return <div className="mt-4 rounded-lg bg-muted/30 p-4"><p className="font-medium">{title}</p><p className="mt-1 text-sm text-muted-foreground">{text}</p></div>; }
