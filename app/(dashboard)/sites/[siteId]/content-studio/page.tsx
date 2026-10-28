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
import { PipelineNavigation, PipelineStageContext } from "@/components/pipeline/pipeline-navigation";

interface Props {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ actionId?: string }>;
}

export default async function ContentStudioPage({ params, searchParams }: Props) {
  const userId = await getUserIdFromCookies();
  const [{ siteId }, query] = await Promise.all([params, searchParams]);
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
        <div className="mb-5 space-y-3"><PipelineNavigation siteId={siteId} currentStage="work" /><PipelineStageContext siteId={siteId} currentStage="work" /></div>
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
      <div className="mb-5 space-y-3"><PipelineNavigation siteId={siteId} currentStage="work" /><PipelineStageContext siteId={siteId} currentStage="work" /></div>
      <ContentStudio
        siteId={siteId}
        domain={site.domain}
        plan={plan}
        initialDrafts={drafts.map(contentDraftView)}
        writerReady={contentWriterConfigured()}
        initialSelectedActionId={query.actionId ?? null}
      />
    </div>
  );
}
