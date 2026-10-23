import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { KeywordResearchClient } from "@/components/research/keyword-research-client";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function KeywordResearchPage({ params }: Props) {
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
        title="Keyword Research"
        description="Discover keyword ideas with search volume, difficulty, and CPC data"
      />
      <KeywordResearchClient siteId={siteId} hasDataForSEO={hasDataForSEO} />
    </div>
  );
}
