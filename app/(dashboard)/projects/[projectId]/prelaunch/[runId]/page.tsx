import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { getPrelaunchReport } from "@/lib/dataforseo/prelaunch-report";
import { PageHeader } from "@/components/ui/page-header";
import { PrelaunchDeriveButton } from "@/components/research/prelaunch-derive-button";

export default async function PrelaunchReportPage({ params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const userId = await getUserIdFromCookies(); if (!userId) redirect("/login");
  const { projectId, runId } = await params;
  const project = await db.project.findFirst({ where: { id: projectId, sites: { some: { userId } } }, select: { id: true, name: true } });
  if (!project) notFound();
  const report = await getPrelaunchReport(projectId, runId); if (!report) notFound();
  return <div><PageHeader eyebrow={project.name} title="Prelaunch research" description={`Period ${report.period} · ${report.status.toLowerCase()} · total cost ${report.totalCostMicros == null ? "Unknown" : `$${(report.totalCostMicros / 1_000_000).toFixed(4)}`}`} actions={<Link className="rounded-lg border border-border px-3 py-2 text-xs" href="/sites">Projects</Link>} />
    <section className="panel mb-5 p-5"><h2 className="font-heading text-lg font-semibold">Tasks and keyword results</h2><div className="mt-3 divide-y divide-border/40">{report.tasks.map((task) => <article className="py-4" key={task.id}><p className="font-medium">{task.seed} · {task.status.toLowerCase()} · cost {task.costMicros == null ? "Unknown" : `$${(task.costMicros / 1_000_000).toFixed(4)}`}</p>{task.errorCode && <p className="text-xs text-muted-foreground">{task.errorCode}</p>}{task.keywords.length ? <ul className="mt-2 space-y-1 text-sm">{task.keywords.map((k, i) => <li key={`${task.id}-${i}`}>{k.keyword} · volume {k.volume} · difficulty {k.difficulty} · intent {k.intent}</li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">No keyword result rows were stored.</p>}</article>)}</div></section>
    <section className="panel mb-5 p-5"><h2 className="font-heading text-lg font-semibold">Skipped tasks</h2>{report.skipped.length ? <ul className="mt-3 space-y-2 text-sm">{report.skipped.map((s, i) => <li key={i}>{s.task}: {s.reason}</li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">No skip reasons were stored.</p>}</section>
    <section className="panel p-5"><h2 className="font-heading text-lg font-semibold">Actions</h2><p className="my-3 text-sm text-muted-foreground">Actions are grounded only in stored keyword results and available site ranking evidence.</p><PrelaunchDeriveButton projectId={projectId} runId={runId} />{report.actions.map((a) => <p className="mt-3" key={a.id}><Link className="text-primary underline" href={`/sites/${a.siteId}/actions/${a.id}`}>{a.title}</Link></p>)}</section>
  </div>;
}
