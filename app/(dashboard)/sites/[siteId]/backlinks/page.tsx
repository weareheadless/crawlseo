import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { BacklinksClient } from "@/components/research/backlinks-client";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function BacklinksPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site || site.userId !== userId) redirect("/sites");

  const hasDataForSEO = !!(await db.apiKey.findUnique({
    where: { userId_provider: { userId, provider: "dataforseo" } },
    select: { id: true },
  }));

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Backlinks"
        description="Analyze your backlink profile, referring domains, and anchor text"
      />
      <BacklinksClient
        siteId={siteId}
        hasDataForSEO={hasDataForSEO}
      />
    </div>
  );
}
