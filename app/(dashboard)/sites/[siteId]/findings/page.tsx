import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { PipelineNavigation, PipelineStageContext } from "@/components/pipeline/pipeline-navigation";
import { actionDimensions, type ActionDimension } from "@/lib/work/categories";
import { readFindings } from "@/lib/pipeline/findings";
import { actionDimension } from "@/lib/work/categories";
import { identityIssues, splitObservations, summarizeDimensions } from "@/lib/research/aeo-geo-view";

export default async function FindingsPage({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<{ dimension?: string }> }) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const { siteId } = await params;
  const { dimension: requested } = await searchParams;
  const dimension = requested === "all" || actionDimensions.includes(requested as ActionDimension) ? requested : "all";
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, domain: true, projectId: true } });
  if (!site) redirect("/sites");
  const [result, crawl, observations, questions, aeoGeoActions] = await Promise.all([
    readFindings(siteId, dimension as "all" | ActionDimension),
    db.crawl.findFirst({ where: { siteId, status: "COMPLETED" }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true, issues: { select: { id: true, type: true, details: true } } } }),
    site.projectId ? db.aIVisibilityObservation.findMany({ where: { projectId: site.projectId }, orderBy: { observedAt: "desc" }, take: 201, select: { id: true, provider: true, modelSurface: true, observedAt: true } }) : Promise.resolve([]),
    site.projectId ? db.questionCoverage.findMany({ where: { projectId: site.projectId }, take: 201, select: { id: true, status: true } }) : Promise.resolve([]),
    db.researchAction.findMany({ where: { siteId }, orderBy: { updatedAt: "desc" }, take: 301, select: { id: true, title: true, status: true, kind: true, source: true } }),
  ]);
  const identity = identityIssues(crawl?.issues ?? []);
  const { customer: customerObservations, fixtures } = splitObservations(observations.slice(0, 200));
  const dimensions = summarizeDimensions(aeoGeoActions.slice(0, 300), actionDimension);
  return <div className="space-y-5">
    <PageHeader eyebrow={site.domain} title={`Findings · ${result.count}`} description="Actionable evidence already recorded for this site. Findings do not create work." />
    <PipelineNavigation siteId={siteId} currentStage="findings" />
    <PipelineStageContext siteId={siteId} currentStage="findings" />
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-heading text-lg font-semibold">AEO / GEO evidence</h2><p className="mt-1 text-sm text-muted-foreground">Evidence lenses over existing technical signals, imported observations and coverage. A missing record is unknown, not a zero result.</p></div><div className="flex gap-3 text-sm"><Link className="text-primary underline" href={`/sites/${siteId}/aeo-geo?tab=access`}>Access</Link><Link className="text-primary underline" href={`/sites/${siteId}/aeo-geo?tab=identity`}>Identity</Link><Link className="text-primary underline" href={`/sites/${siteId}/aeo-geo?tab=visibility`}>Visibility</Link><Link className="text-primary underline" href={`/sites/${siteId}/aeo-geo?tab=questions`}>Questions</Link></div></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Evidence label="Identity issues · latest crawl" value={crawl ? String(identity.length) : "Unknown"} note={crawl ? `Evidence ${crawl.finishedAt?.toLocaleDateString() ?? "date unavailable"}` : "No completed crawl evidence"} />
        <Evidence label="Customer visibility observations" value={customerObservations.length ? String(customerObservations.length) : "Unknown"} note={customerObservations.length ? `Latest ${customerObservations[0].observedAt.toLocaleDateString()}` : "No customer export; not zero mentions"} />
        <Evidence label="Question coverage" value={questions.length ? `${questions.slice(0, 200).filter((q) => q.status === "COVERED").length} covered / ${questions.slice(0, 200).filter((q) => q.status !== "COVERED").length} unresolved` : "Unknown"} note={questions.length ? `Recorded project question coverage${questions.length > 200 ? " · first 200, truncated" : ""}` : "No coverage evidence recorded"} />
        <Evidence label="Existing AEO / GEO actions" value={`${dimensions.aeoTotal} AEO · ${dimensions.geoTotal} GEO`} note={`Counts from ${Math.min(aeoGeoActions.length, 300)} site actions${aeoGeoActions.length > 300 ? " · first 300, truncated" : ""}`} />
      </div>
      {(fixtures.length > 0 || observations.length > 200 || questions.length > 200) && <p className="mt-3 text-xs text-muted-foreground">{fixtures.length > 0 ? `${fixtures.length} observation fixtures excluded from customer visibility; fixture status is determined by observation provider/model surface. ` : ""}{observations.length > 200 ? "Observation list truncated to 200. " : ""}{questions.length > 200 ? "Question coverage list truncated to 200." : ""}</p>}
      <div className="mt-3 flex flex-wrap gap-4 text-sm"><Link className="text-primary underline" href={`/sites/${siteId}/aeo-geo?tab=gaps`}>AEO / GEO details</Link><Link className="text-primary underline" href={`/sites/${siteId}/crawl`}>Open crawl audit</Link></div>
    </section>
    <nav aria-label="Filter findings" className="flex flex-wrap gap-2">{["all", ...actionDimensions].map((key) => <Link key={key} aria-current={dimension === key ? "page" : undefined} className={`rounded-md border px-3 py-2 text-sm ${dimension === key ? "border-primary text-primary" : "border-border text-muted-foreground"}`} href={`/sites/${siteId}/findings?dimension=${key}`}>{key === "all" ? "All dimensions" : key.toUpperCase()}</Link>)}</nav>
    {!result.available ? <section className="panel p-5"><h2 className="font-heading text-lg font-semibold">No actionable evidence recorded</h2><p className="mt-2 text-sm text-muted-foreground">This is missing evidence, not zero issues. Run the relevant upstream research or crawl, then review its recorded findings here.</p><div className="mt-3 flex gap-4 text-sm"><Link className="text-primary underline" href={`/sites/${siteId}/research`}>Research</Link><Link className="text-primary underline" href={`/sites/${siteId}/crawl`}>Crawl audit</Link></div></section> : result.count === 0 ? <section className="panel p-5 text-sm text-muted-foreground">No findings match this dimension filter. Choose another dimension to review the site&apos;s recorded evidence.</section> : <section className="panel divide-y divide-border/50">{result.rows.map((row) => <article key={row.id} className="p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-medium">{row.title}</h2><p className="mt-1 text-sm text-muted-foreground">{row.finding?.summary ?? row.recommendation}</p></div><span className="rounded-md bg-muted px-2 py-1 text-xs">{row.source.replaceAll("_", " ")} · {row.status.toLowerCase()}</span></div><p className="mt-2 text-xs text-muted-foreground">{row.finding?.run ? `Research run · ${row.finding.run.createdAt.toLocaleString()}` : `Updated · ${row.updatedAt.toLocaleString()}`} · {row.targetUrl ?? "Affected page not recorded"}</p><Link className="mt-2 inline-block text-sm text-primary underline underline-offset-2" href={`/sites/${siteId}/actions/${row.id}`}>Open existing canonical work →</Link></article>)}</section>}
    {result.hasMore && <p className="text-xs text-muted-foreground">Showing {result.count} of at least {result.count + 1} matching findings; list truncated.</p>}
  </div>;
}

function Evidence({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="rounded-lg bg-muted/30 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-medium">{value}</p><p className="mt-1 text-xs text-muted-foreground">{note}</p></div>;
}
