import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { PipelineNavigation, PipelineStageContext } from "@/components/pipeline/pipeline-navigation";
import { actionDimensions, type ActionDimension } from "@/lib/work/categories";
import { readFindings } from "@/lib/pipeline/findings";

export default async function FindingsPage({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<{ dimension?: string }> }) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const { siteId } = await params;
  const { dimension: requested } = await searchParams;
  const dimension = requested === "all" || actionDimensions.includes(requested as ActionDimension) ? requested : "all";
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, domain: true } });
  if (!site) redirect("/sites");
  const result = await readFindings(siteId, dimension as "all" | ActionDimension);
  return <div className="space-y-5">
    <PageHeader eyebrow={site.domain} title={`Findings · ${result.count}`} description="Actionable evidence already recorded for this site. Findings do not create work." />
    <PipelineNavigation siteId={siteId} currentStage="findings" />
    <PipelineStageContext siteId={siteId} currentStage="findings" />
    <nav aria-label="Filter findings" className="flex flex-wrap gap-2">{["all", ...actionDimensions].map((key) => <Link key={key} aria-current={dimension === key ? "page" : undefined} className={`rounded-md border px-3 py-2 text-sm ${dimension === key ? "border-primary text-primary" : "border-border text-muted-foreground"}`} href={`/sites/${siteId}/findings?dimension=${key}`}>{key === "all" ? "All dimensions" : key.toUpperCase()}</Link>)}</nav>
    {!result.available ? <section className="panel p-5"><h2 className="font-heading text-lg font-semibold">No actionable evidence recorded</h2><p className="mt-2 text-sm text-muted-foreground">This is missing evidence, not zero issues. Run the relevant upstream research or crawl, then review its recorded findings here.</p><div className="mt-3 flex gap-4 text-sm"><Link className="text-primary underline" href={`/sites/${siteId}/research`}>Research</Link><Link className="text-primary underline" href={`/sites/${siteId}/crawl`}>Crawl audit</Link></div></section> : result.count === 0 ? <section className="panel p-5 text-sm text-muted-foreground">No findings match this dimension filter. Choose another dimension to review the site&apos;s recorded evidence.</section> : <section className="panel divide-y divide-border/50">{result.rows.map((row) => <article key={row.id} className="p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-medium">{row.title}</h2><p className="mt-1 text-sm text-muted-foreground">{row.finding?.summary ?? row.recommendation}</p></div><span className="rounded-md bg-muted px-2 py-1 text-xs">{row.source.replaceAll("_", " ")} · {row.status.toLowerCase()}</span></div><p className="mt-2 text-xs text-muted-foreground">{row.finding?.run ? `Research run · ${row.finding.run.createdAt.toLocaleString()}` : `Updated · ${row.updatedAt.toLocaleString()}`} · {row.targetUrl ?? "Affected page not recorded"}</p><Link className="mt-2 inline-block text-sm text-primary underline underline-offset-2" href={`/sites/${siteId}/actions/${row.id}`}>Open existing canonical work →</Link></article>)}</section>}
    {result.hasMore && <p className="text-xs text-muted-foreground">Showing {result.count} of at least {result.count + 1} matching findings; list truncated.</p>}
  </div>;
}
