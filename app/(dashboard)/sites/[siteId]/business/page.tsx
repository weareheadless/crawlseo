import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { profileFields, profileValue, confirmationStatus } from "@/lib/projects/business-profile-view";
import { readBusinessKnowledge } from "@/lib/projects/business-knowledge";
import { getResearchConfig } from "@/lib/research/policy";

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

  const profileRecord: Record<string, unknown> = profile
    ? {
        audience: profile.audience,
        topics: profile.topics,
        services: profile.services,
        competitors: profile.competitors,
        brandVoice: profile.brandVoice,
        constraints: profile.constraints,
        country: profile.country,
        language: profile.language,
      }
    : {};

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

      <section className="panel p-4 sm:p-5">
        <h2 className="font-heading text-lg font-semibold">Site profile</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The operating facts research and content prompts use. &ldquo;Not recorded&rdquo; means nobody has
          supplied the fact yet.
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {profileFields.map((field) => (
            <div key={field} className="rounded-lg bg-muted/30 p-3">
              <dt className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{field}</dt>
              <dd className="mt-1 break-words text-sm">{profileValue(profileRecord[field])}</dd>
            </div>
          ))}
        </dl>
      </section>

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
