import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { profileValue, confirmationStatus } from "@/lib/projects/business-profile-view";
import { readBusinessKnowledge } from "@/lib/projects/business-knowledge";
import { getResearchConfig } from "@/lib/research/policy";
import { BusinessOperationalForm } from "@/components/business/business-operational-form";

export default async function BusinessPage({ params }: { params: Promise<{ siteId: string }> }) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site) redirect("/sites");

  const [head, profile, config] = await Promise.all([
    site.projectId
      ? db.businessKnowledgeDocument.findUnique({
          where: { projectId: site.projectId },
          select: { logicalId: true, revision: true, acceptedRevision: true, updatedAt: true },
        })
      : null,
    db.siteProfile.findUnique({ where: { siteId } }),
    getResearchConfig(siteId),
  ]);

  let document = null;
  if (head && site.projectId) {
    try {
      document = await readBusinessKnowledge(
        site.projectId,
        head.logicalId,
        head.acceptedRevision ?? undefined,
        head.acceptedRevision ? "accepted" : "working"
      );
    } catch {
      document = null;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={site.domain}
        title="Business profile"
        description="Recorded business facts, where each came from, and the research configuration derived from them."
      />

      <section className="panel p-4 sm:p-5">
        <h2 className="font-heading text-lg font-semibold">Canonical knowledge</h2>
        {!head ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No canonical business knowledge document is recorded for this project. It is created when a
            research run or intake confirms business facts. Until then these facts are unknown, not empty.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm">
              {document?.state ?? "unreadable"} · revision {head.revision} · accepted{" "}
              {head.acceptedRevision ?? "none"} · updated {head.updatedAt.toLocaleString()}
            </p>
            {head.acceptedRevision == null && (
              <p className="mt-1 text-xs text-warning">
                The working revision has not been accepted; treat these facts as unconfirmed.
              </p>
            )}
            {!document ? (
              <p className="mt-3 text-sm text-muted-foreground">
                The canonical revision exists but could not be read or failed validation. No facts are inferred.
              </p>
            ) : (
              <div className="mt-3 divide-y divide-border/50">
                {Object.entries(document.fields).map(([field, fact]) => (
                  <article key={field} className="py-3">
                    <h3 className="font-medium">{field}</h3>
                    <p className="break-words text-sm">{profileValue(fact.value)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {fact.provenance.kind} · {fact.provenance.originSystem}/{fact.provenance.originRecordId} ·{" "}
                      {fact.provenance.status} ({confirmationStatus(fact.provenance.status)})
                    </p>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
        <p className="mt-3 text-sm text-muted-foreground">
          Corrections are made through the existing intake and research path; this page is read-only and does
          not keep a second profile store.
        </p>
      </section>

      <BusinessOperationalForm siteId={siteId} revision={config.policy?.revision ?? 0} profileUpdatedAt={profile?.updatedAt.toISOString() ?? null} initial={{
        topics: config.topics, audience: config.audience, market: config.market, language: config.language,
        goals: config.goals, services: Array.isArray(profile?.services) ? profile.services.filter((value): value is string => typeof value === "string") : [],
        competitors: Array.isArray(profile?.competitors) ? profile.competitors.filter((value): value is string => typeof value === "string") : [],
        brandVoice: typeof profile?.brandVoice === "string" ? profile.brandVoice : "",
      }} />

      <section className="panel p-4 sm:p-5">
        <h2 className="font-heading text-lg font-semibold">Research configuration</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Topics" value={config.topics.join(", ") || "Not recorded"} />
          <Fact label="Audience" value={config.audience || "Not recorded"} />
          <Fact label="Market" value={config.market || "Not recorded"} />
          <Fact label="Providers" value={config.providers.join(", ") || "Not recorded"} />
        </div>
        <Link
          className="mt-3 inline-block text-sm text-primary underline underline-offset-2"
          href={`/sites/${siteId}/research/config`}
        >
          View and edit research configuration
        </Link>
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
