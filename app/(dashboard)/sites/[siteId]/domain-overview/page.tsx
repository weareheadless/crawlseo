import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { resolveDataForSeoReadiness } from "@/lib/dataforseo/readiness";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { DomainOverviewClient } from "@/components/research/domain-overview-client";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function DomainOverviewPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true, projectId: true },
  });
  if (!site) redirect("/sites");

  // Read the credential the way the client does: a project grant or the
  // workspace key, not only a key stored by whoever is signed in.
  const hasDataForSEO = (await resolveDataForSeoReadiness({ projectId: site.projectId, userId })).configured;

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Domain Overview"
        description="Organic traffic, keyword rankings, and backlink metrics"
      />
      <DomainOverviewClient
        siteId={siteId}
        domain={site.domain}
        hasDataForSEO={hasDataForSEO}
      />
    </div>
  );
}
