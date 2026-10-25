import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { getResearchConfig } from "@/lib/research/policy";
import { listResearchRuns } from "@/lib/research/service";

export default async function ResearchPage({ params }: { params: Promise<{ siteId: string }> }) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, domain: true } });
  if (!site) redirect("/sites");

  const [config, runs] = await Promise.all([getResearchConfig(siteId), listResearchRuns(siteId)]);

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Research"
        description="Autonomous market research driven by your site configuration."
        actions={
          <div className="flex items-center gap-2">
            <DataLagBadge />
            <Link href={`/sites/${siteId}/research/config`} className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground">
              Edit configuration
            </Link>
            <Link href={`/sites/${siteId}/work`} className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground">
              Work queue
            </Link>
          </div>
        }
      />

      <section className="panel mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Research configuration</p>
            <h2 className="mt-1 font-heading text-lg font-semibold">{config.enabled ? "Active" : "Paused"} · {config.cadence}</h2>
          </div>
          <Link href={`/sites/${siteId}/research/config`} className="text-xs text-primary underline underline-offset-2">
            Guide the AI
          </Link>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Topics" value={config.topics.join(", ") || "Not configured"} />
          <Fact label="Audience" value={config.audience || "Not configured"} />
          <Fact label="Market" value={config.market || "Not configured"} />
          <Fact label="Providers" value={config.providers.join(", ")} />
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Research currently searches Reddit and Google News RSS. General web and competitor providers are not available yet; runs that request them record that limitation instead of implying those sources were searched.
        </p>
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-border/60 p-5">
          <h2 className="font-heading text-lg font-semibold">Research runs</h2>
          <p className="mt-1 text-sm text-muted-foreground">Sources, findings, and actions produced by the engine.</p>
        </div>
        {runs.length === 0 ? (
          <p className="px-5 py-10 text-sm text-muted-foreground">No research runs yet. Configure topics and cadence to let the engine start.</p>
        ) : (
          <div className="divide-y divide-border/40">
            {runs.map((run) => (
              <Link
                key={run.id}
                href={`/sites/${siteId}/research/runs/${run.id}`}
                className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 transition hover:bg-muted/20"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{run.title}</p>
                    <span className="rounded-md bg-muted px-1.5 py-0.5 font-data text-[10px] uppercase text-muted-foreground">
                      {run.status.toLowerCase()}
                    </span>
                  </div>
                  <p className="mt-1 font-data text-[10px] text-muted-foreground">
                    {run.createdAt.toLocaleString()} · {run._count.sources} sources · {run._count.findings} findings · {run._count.actions} actions
                  </p>
                  {run.errorCode && <p className="mt-1 text-xs text-warning">{run.errorCode.replaceAll("_", " ").toLowerCase()}</p>}
                </div>
                <span className="shrink-0 self-center text-xs font-medium text-primary">View sources →</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-data text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 break-words text-xs text-foreground/90">{value}</p>
    </div>
  );
}
