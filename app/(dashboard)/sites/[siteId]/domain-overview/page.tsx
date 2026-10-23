import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
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
    select: { userId: true, domain: true },
  });
  if (!site) redirect("/sites");

  const hasDataForSEO = !!(await db.apiKey.findUnique({
    where: { userId_provider: { userId, provider: "dataforseo" } },
    select: { id: true },
  }));

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
