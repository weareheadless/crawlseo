import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { getResearchConfig } from "@/lib/research/policy";
import { ResearchConfigForm } from "@/components/research/research-config-form";

/**
 * Collection rules for evidence. This used to live under `/research`, which is
 * no longer a stage: the settings decide which sources the evidence collectors
 * read, so they belong to Evidence.
 */
export default async function EvidenceConfigPage({ params }: { params: Promise<{ siteId: string }> }) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const { siteId } = await params;
  const config = await getResearchConfig(siteId);

  return (
    <div>
      <PageHeader
        eyebrow="Evidence configuration"
        title="Guide the collection"
        description="Set the sources, recency window and exclusions the evidence collectors use. Audience, topics and market belong to the business profile."
        actions={
          <Link href={`/sites/${siteId}/evidence`} className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground">
            Back to Evidence
          </Link>
        }
      />
      <ResearchConfigForm
        siteId={siteId}
        initial={{
          exclusions: config.exclusions,
          recencyDays: config.recencyDays,
          providers: config.providers.filter((provider) => provider === "reddit" || provider === "news"),
          maxSources: config.maxSources,
          revision: config.policy?.revision ?? 0,
          profileUpdatedAt: config.profile?.updatedAt?.toISOString() ?? null,
        }}
      />
    </div>
  );
}
