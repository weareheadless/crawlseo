import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { getResearchConfig } from "@/lib/research/policy";
import { ResearchConfigForm } from "@/components/research/research-config-form";

export default async function ResearchConfigPage({ params }: { params: Promise<{ siteId: string }> }) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");
  const config = await getResearchConfig(siteId);

  return (
    <div>
      <PageHeader
        eyebrow="Research configuration"
        title="Guide the research"
        description="Set research topics, audience, market, and supported sources. The engine creates a bounded query plan from this configuration."
        actions={
          <Link href={`/sites/${siteId}/research`} className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground">
            Back to Research
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
