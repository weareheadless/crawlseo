import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { getContentActionPlan } from "@/lib/ai-seo/content-plan";
import { contentDraftView } from "@/lib/ai-seo/drafts";
import { contentWriterConfigured } from "@/lib/ai-seo/writer";
import { ContentStudio } from "@/components/content/content-studio";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function ContentStudioPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true, _count: { select: { keywords: true } } },
  });
  if (!site) redirect("/sites");

  if (site._count.keywords === 0) {
    return (
      <div>
        <PageHeader
          eyebrow={site.domain}
          title="Content Studio"
          description="Turn search evidence into reviewable content drafts"
        />
        <EmptyState
          title="Sync Search Console first"
          description="Content Studio needs query and page performance before it can rank opportunities."
          actionLabel="Back to overview"
          actionHref={`/sites/${siteId}`}
        />
      </div>
    );
  }

  const [plan, drafts] = await Promise.all([
    getContentActionPlan(siteId, site.domain),
    db.contentDraft.findMany({
      where: { siteId, status: "READY" },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Content Studio"
        description="Prioritised SEO actions, grounded drafts, and a review queue. Nothing is published from this page."
        actions={<DataLagBadge />}
      />
      <ContentStudio
        siteId={siteId}
        domain={site.domain}
        plan={plan}
        initialDrafts={drafts.map(contentDraftView)}
        writerReady={contentWriterConfigured()}
      />
    </div>
  );
}
