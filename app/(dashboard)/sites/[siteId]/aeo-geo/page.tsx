import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { actionDimension } from "@/lib/work/categories";
import { PipelineNavigation } from "@/components/pipeline/pipeline-navigation";
import {
  accessState,
  groupIssuesByType,
  groupObservations,
  identityIssues,
  observationCount,
  splitObservations,
  summarizeDimensions,
} from "@/lib/research/aeo-geo-view";

const tabs = ["access", "identity", "visibility", "questions", "gaps"] as const;
type Tab = (typeof tabs)[number];

const tabLabels: Record<Tab, string> = {
  access: "Access",
  identity: "Identity",
  visibility: "Visibility",
  questions: "Questions",
  gaps: "Gaps",
};

export default async function AeoGeoPage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const { siteId } = await params;
  const requested = (await searchParams).tab;
  const tab: Tab = tabs.includes(requested as Tab) ? (requested as Tab) : "access";

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site) redirect("/sites");

  const [crawl, observationRows, questions, actions] = await Promise.all([
    db.crawl.findFirst({
      where: { siteId, status: "COMPLETED" },
      orderBy: { finishedAt: "desc" },
      select: { id: true, finishedAt: true, issues: { select: { id: true, type: true, details: true } } },
    }),
    site.projectId
      ? db.aIVisibilityObservation.findMany({
          where: { projectId: site.projectId },
          orderBy: [{ observedAt: "desc" }, { provider: "asc" }, { modelSurface: "asc" }],
          take: 200,
        })
      : Promise.resolve([]),
    site.projectId
      ? db.questionCoverage.findMany({
          where: { projectId: site.projectId },
          include: {
            action: { select: { id: true, title: true } },
            document: { select: { logicalId: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 200,
        })
      : Promise.resolve([]),
    db.researchAction.findMany({
      where: { siteId },
      orderBy: { updatedAt: "desc" },
      take: 300,
      select: { id: true, title: true, status: true, kind: true, source: true, evidence: true },
    }),
  ]);

  const access = accessState(crawl);
  const identity = identityIssues(crawl?.issues ?? []);
  const { customer, fixtures } = splitObservations(observationRows);
  const grouped = groupObservations(customer);
  const dimensions = summarizeDimensions(actions, actionDimension);
  const unresolved = questions.filter((row) => row.status !== "COVERED");

  const counts: Record<Tab, number> = {
    access: crawl ? 3 : 0,
    identity: identity.length,
    visibility: customer.length,
    questions: questions.length,
    gaps: dimensions.aeoTotal + dimensions.geoTotal,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={site.domain}
        title="AEO / GEO"
        description="Answer-engine access, identity signals, observed visibility and the gaps that follow. Access does not imply visibility."
      />
      <div className="mb-5"><PipelineNavigation siteId={siteId} currentStage="findings" /></div>
      <div className="-mt-3 mb-4 text-sm"><Link className="text-primary underline underline-offset-2" href={`/sites/${siteId}/findings`}>View all Findings →</Link></div>

      <nav className="flex flex-wrap gap-1 rounded-lg border border-border/60 bg-panel/60 p-1 text-sm">
        {tabs.map((item) => (
          <Link
            key={item}
            href={`/sites/${siteId}/aeo-geo?tab=${item}`}
            aria-current={item === tab ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 font-medium transition ${
              item === tab ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tabLabels[item]} <span className="font-data text-xs text-muted-foreground">{counts[item]}</span>
          </Link>
        ))}
      </nav>

      {tab === "access" && (
        <section className="panel p-4 sm:p-5">
          <h2 className="font-heading text-lg font-semibold">Access</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Technical signals from the latest completed crawl. They do not measure whether an answer engine
            mentions the site.
          </p>
          {!crawl ? (
            <p className="mt-4 rounded-lg bg-muted/30 p-4 text-sm">Crawl evidence unavailable; access is unknown.</p>
          ) : (
            <>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Fact label="Robots / AI crawlers" value={access.robots === "restricted" ? "Potential restriction found" : "No blocking issue found"} />
                <Fact label="Sitemap" value={access.sitemap === "missing" ? "Not found by crawl" : "No missing-sitemap issue found"} />
                <Fact label="HTTP reachability" value={access.reachability === "responded" ? "Pages responded during crawl" : "Unknown"} />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Crawl evidence · {crawl.finishedAt ? crawl.finishedAt.toLocaleString() : "date unavailable"} ·{" "}
                <Link className="text-primary underline underline-offset-2" href={`/sites/${siteId}/crawl`}>
                  open crawl audit
                </Link>
              </p>
            </>
          )}
        </section>
      )}

      {tab === "identity" && (
        <section className="panel p-4 sm:p-5">
          <h2 className="font-heading text-lg font-semibold">Identity signals · {identity.length}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Structured data and identity facts that answer engines use to recognise the business.
          </p>
          {identity.length === 0 ? (
            <p className="mt-4 rounded-lg bg-muted/30 p-4 text-sm">
              No identity or structured-data issue is recorded in the latest crawl. That is not proof the
              markup is complete: the crawl only reports what it checks.
            </p>
          ) : (
            <div className="mt-3 divide-y divide-border/50">
              {groupIssuesByType(identity).map((group) => (
                <article key={group.type} className="py-3">
                  <p className="font-medium">
                    {group.type.replaceAll("_", " ").toLowerCase()} · {group.count}
                  </p>
                  <Link
                    className="mt-1 inline-block text-xs text-primary underline underline-offset-2"
                    href={`/sites/${siteId}/crawl`}
                  >
                    View producing crawl issues
                  </Link>
                </article>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Missing identity markup usually becomes a fix_business_identity_jsonld Action; see the Gaps tab.
          </p>
        </section>
      )}

      {tab === "visibility" && (
        <section className="panel p-4 sm:p-5">
          <h2 className="font-heading text-lg font-semibold">Visibility observations · {customer.length}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Imported provider exports only. Each denominator and count comes from its export.
          </p>
          {customer.length === 0 ? (
            <p className="mt-4 rounded-lg bg-muted/30 p-4 text-sm">
              No authorized export has been imported, so visibility is unknown — this is not zero mentions.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {grouped.map((group) => (
                <div key={group.key} className="rounded-lg border border-border/60 p-3">
                  <h3 className="font-medium">{group.key}</h3>
                  <div className="mt-2 divide-y divide-border/40">
                    {group.rows.map((row) => (
                      <div key={row.id} className="py-2 text-sm">
                        <p className="font-medium">{row.question}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Set {row.questionSetVersion} · observed {row.observedAt.toLocaleDateString()} ·
                          denominator {row.denominator} (provider-reported)
                        </p>
                        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          <span>Mentions: {observationCount(row.mentions) ?? "unknown"}</span>
                          <span>Recommendations: {observationCount(row.recommendations) ?? "unknown"}</span>
                          <span>Citations: {observationCount(row.citations) ?? "unknown"}</span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {fixtures.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {fixtures.length} fixture observation{fixtures.length === 1 ? "" : "s"} exist to prove the import
              contract and are excluded from these totals.
            </p>
          )}
        </section>
      )}

      {tab === "questions" && (
        <section className="panel p-4 sm:p-5">
          <h2 className="font-heading text-lg font-semibold">
            Question coverage · {questions.length}
            {questions.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {questions.length - unresolved.length} covered · {unresolved.length} unresolved
              </span>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Customer questions and whether the accepted content actually answers them.
          </p>
          {questions.length === 0 ? (
            <p className="mt-4 rounded-lg bg-muted/30 p-4 text-sm">
              No coverage is recorded yet. Coverage appears when a draft is accepted and evaluated against
              confirmed knowledge.
            </p>
          ) : (
            <div className="mt-3 divide-y divide-border/50">
              {questions.map((row) => (
                <article key={row.id} className="py-3">
                  <p className="font-medium">{row.question || "Question not recorded"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.status.toLowerCase()} · service {row.service} · locale {row.locale}
                    {row.status === "COVERED"
                      ? ` · field ${row.fieldPath ?? "unknown"} · revision ${row.evidenceRevision ?? "unknown"}`
                      : ` · ${row.missingEvidence ?? "missing evidence not specified"}`}
                  </p>
                  {row.action && (
                    <Link
                      className="mt-1 inline-block text-sm text-primary underline underline-offset-2"
                      href={`/sites/${siteId}/actions/${row.action.id}`}
                    >
                      Action: {row.action.title}
                    </Link>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "gaps" && (
        <section className="panel p-4 sm:p-5">
          <h2 className="font-heading text-lg font-semibold">AEO / GEO gaps</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Actions derived from identity, citation and coverage gaps, grouped by state.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(["aeo", "geo"] as const).map((dimension) => {
              const states = dimensions[dimension];
              const total = dimension === "aeo" ? dimensions.aeoTotal : dimensions.geoTotal;
              return (
                <div key={dimension} className="rounded-lg bg-muted/30 p-4">
                  <h3 className="font-medium">
                    {dimension.toUpperCase()} · {total}
                  </h3>
                  {total === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      No {dimension.toUpperCase()} Action is recorded. This does not prove there is no gap; it
                      means nothing has been detected and turned into work yet.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm">
                      {Object.entries(states).map(([state, count]) => (
                        <li key={state}>
                          {state.replaceAll("_", " ")} · {count}
                        </li>
                      ))}
                    </ul>
                  )}
                  <Link
                    className="mt-2 inline-block text-xs text-primary underline underline-offset-2"
                    href={`/sites/${siteId}/work?dimension=${dimension}`}
                  >
                    Open {dimension.toUpperCase()} work
                  </Link>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Actions live in the shared work queue; this page does not create or change them.
          </p>
          {identity.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {identity.length} crawl issue{identity.length === 1 ? "" : "s"} about schema or identity are
              currently classified as technical work, so they do not appear in the AEO count above.{" "}
              <Link className="text-primary underline underline-offset-2" href={`/sites/${siteId}/aeo-geo?tab=identity`}>
                Review them in Identity
              </Link>
              .
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/30 p-3">
      <p className="text-xs font-medium">{label}</p>
      <p className="mt-1 text-sm">{value}</p>
    </div>
  );
}
