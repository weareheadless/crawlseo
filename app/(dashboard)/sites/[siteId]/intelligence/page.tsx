import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { provenanceNote, summarizeIntelligence } from "@/lib/research/intelligence-overview";
import { identityIssues, splitObservations } from "@/lib/research/aeo-geo-view";
import { readBusinessKnowledge } from "@/lib/projects/business-knowledge";
import { PipelineNavigation } from "@/components/pipeline/pipeline-navigation";

export default async function IntelligencePage({ params }: { params: Promise<{ siteId: string }> }) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site) redirect("/sites");
  const projectId = site.projectId;

  const [keywordCount, actions, researchRuns, keywordRuns, sources, observations, coverage, crawl, knowledge, latestRun] =
    await Promise.all([
      db.keyword.count({ where: { siteId } }),
      db.researchAction.findMany({
        where: { siteId },
        select: { id: true, title: true, status: true, kind: true, evidence: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      }),
      db.researchRun.count({ where: { siteId } }),
      db.articleKeywordResearchRun.count({ where: { siteId } }),
      db.researchSource.count({ where: { run: { siteId } } }),
      projectId ? db.aIVisibilityObservation.findMany({ where: { projectId }, select: { provider: true, modelSurface: true } }) : Promise.resolve([]),
      projectId ? db.questionCoverage.findMany({ where: { projectId }, select: { status: true } }) : Promise.resolve([]),
      db.crawl.findFirst({
        where: { siteId, status: "COMPLETED" },
        orderBy: { finishedAt: "desc" },
        select: { finishedAt: true, issues: { select: { id: true, type: true, details: true } } },
      }),
      projectId
        ? db.businessKnowledgeDocument.findUnique({
            where: { projectId },
            select: { logicalId: true, revision: true, acceptedRevision: true },
          })
        : null,
      db.researchRun.findFirst({
        where: { siteId },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, status: true, createdAt: true, sourceCount: true, findingCount: true, actionCount: true },
      }),
    ]);

  let knowledgeState: string | null = null;
  if (projectId && knowledge) {
    try {
      const document = await readBusinessKnowledge(
        projectId,
        knowledge.logicalId,
        knowledge.acceptedRevision ?? undefined,
        knowledge.acceptedRevision ? "accepted" : "working"
      );
      knowledgeState = `${document.state} revision ${document.revision}`;
    } catch {
      knowledgeState = "unreadable";
    }
  }

  const counts = summarizeIntelligence({
    keywords: keywordCount,
    actions,
    researchRuns,
    keywordRuns,
    sources,
    observations: splitObservations(observations).customer.length,
    coverage,
  });
  const note = provenanceNote(counts);
  const identity = identityIssues(crawl?.issues ?? []);
  const latestActions = actions.slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={site.domain}
        title="Intelligence"
        description="What CrawlSEO knows about this site, where it came from, and what is still unknown. Access does not imply visibility."
      />
      <PipelineNavigation siteId={siteId} currentStage="findings" />
      <section className="panel p-4 sm:p-5">
        <h2 className="font-heading text-lg font-semibold">Intelligence reports</h2>
        <p className="mt-1 text-sm text-muted-foreground">This page is a read-only evidence lens. Use the site overview for current decisions and Results for recorded delivery and observations.</p>
        <div className="mt-3 flex flex-wrap gap-4 text-sm"><Link className="text-primary underline" href={`/sites/${siteId}`}>Site overview</Link><Link className="text-primary underline" href={`/sites/${siteId}/results`}>Results</Link></div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Keywords tracked" value={counts.keywords.toLocaleString()} href={`/sites/${siteId}/keywords`} />
        <Stat label="Open Actions" value={`${counts.openActions} of ${counts.actions}`} href={`/sites/${siteId}/work`} />
        <Stat label="Research runs" value={String(counts.researchRuns)} href={`/sites/${siteId}/research`} />
        <Stat label="Keyword research runs" value={String(counts.keywordRuns)} href={`/sites/${siteId}/keyword-research`} />
        <Stat label="Sources retrieved" value={String(counts.sources)} href={`/sites/${siteId}/research`} />
        <Stat label="Visibility observations" value={counts.observations === 0 ? "None imported" : String(counts.observations)} href={`/sites/${siteId}/aeo-geo?tab=visibility`} />
        <Stat label="Question coverage" value={`${counts.coverage - counts.unresolvedCoverage} of ${counts.coverage}`} href={`/sites/${siteId}/aeo-geo?tab=questions`} />
        <Stat label="Identity issues" value={String(identity.length)} href={`/sites/${siteId}/aeo-geo?tab=identity`} />
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <Card
          title="Business profile"
          href={`/sites/${siteId}/business`}
          body={
            knowledge
              ? `${knowledgeState ?? "unknown"} · accepted ${knowledge.acceptedRevision ?? "none"}`
              : "No canonical knowledge document recorded. Business facts are unknown, not empty."
          }
          cta="Open business profile"
        />
        <Card
          title="AEO / GEO"
          href={`/sites/${siteId}/aeo-geo`}
          body={`${identity.length} identity issue${identity.length === 1 ? "" : "s"} · ${counts.observations} visibility observation${counts.observations === 1 ? "" : "s"} imported · ${counts.unresolvedCoverage} unresolved question${counts.unresolvedCoverage === 1 ? "" : "s"}`}
          cta="Open AEO / GEO workspace"
        />
        <Card
          title="Keyword research"
          href={`/sites/${siteId}/keyword-research`}
          body={`${counts.keywordRuns} stored DataForSEO run${counts.keywordRuns === 1 ? "" : "s"} · ${counts.keywords.toLocaleString()} ranking keywords from Search Console`}
          cta="Open keyword research"
        />
      </section>

      <section className="panel p-4 sm:p-5">
        <h2 className="font-heading text-lg font-semibold">Latest research run</h2>
        {!latestRun ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No research run is recorded. Configure research to start one.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm">
              <Link className="font-medium text-primary underline underline-offset-2" href={`/sites/${siteId}/research/runs/${latestRun.id}`}>
                {latestRun.title}
              </Link>{" "}
              · {latestRun.status.toLowerCase()} · {latestRun.createdAt.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {latestRun.sourceCount} sources · {latestRun.findingCount} findings · {latestRun.actionCount} Actions
            </p>
          </>
        )}
      </section>

      <section className="panel p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-heading text-lg font-semibold">Recent Actions</h2>
          <Link className="text-xs text-primary underline underline-offset-2" href={`/sites/${siteId}/work`}>
            Open the work queue ({counts.openActions} open)
          </Link>
        </div>
        {latestActions.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No Action is recorded for this site. That does not establish that no work is needed.
          </p>
        ) : (
          <div className="mt-3 divide-y divide-border/50">
            {latestActions.map((action) => (
              <article key={action.id} className="py-3">
                <Link className="font-medium text-primary underline underline-offset-2" href={`/sites/${siteId}/actions/${action.id}`}>
                  {action.title}
                </Link>
                <p className="mt-1 text-xs text-muted-foreground">
                  {action.status.toLowerCase()} · {action.kind} · updated {action.updatedAt.toLocaleDateString()}
                </p>
              </article>
            ))}
          </div>
        )}
        {note && <p className="mt-3 text-xs text-muted-foreground">{note}</p>}
      </section>

      <section className="panel p-4 sm:p-5">
        <h2 className="font-heading text-lg font-semibold">AI access readiness</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Technical access signals from the latest completed crawl. They do not measure whether an answer engine mentions the site.
        </p>
        {!crawl ? (
          <p className="mt-3 text-sm text-muted-foreground">No completed crawl; access is unknown.</p>
        ) : (
          <p className="mt-3 text-sm">
            {identity.length} identity or structured-data issue{identity.length === 1 ? "" : "s"} · crawl{" "}
            {crawl.finishedAt?.toLocaleString() ?? "date unavailable"} ·{" "}
            <Link className="text-primary underline underline-offset-2" href={`/sites/${siteId}/aeo-geo?tab=access`}>
              open access detail
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link href={href} className="panel block p-4 transition hover:bg-muted/30">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-data text-xl">{value}</p>
    </Link>
  );
}

function Card({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return (
    <div className="panel flex flex-col justify-between p-4 sm:p-5">
      <div>
        <h2 className="font-heading text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      </div>
      <Link className="mt-3 text-sm text-primary underline underline-offset-2" href={href}>
        {cta}
      </Link>
    </div>
  );
}
