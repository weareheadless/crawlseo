import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { PageHeader } from "@/components/ui/page-header";
import { getResearchConfig } from "@/lib/research/policy";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { inspectBridgeSite } from "@/lib/bridge/client";
import { ResearchConfigForm } from "@/components/research/research-config-form";

export default async function ResearchConfigPage({ params }: { params: Promise<{ siteId: string }> }) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");
  const [config, delivery] = await Promise.all([
    getResearchConfig(siteId),
    getSiteDeliveryConfig(siteId),
  ]);
  let bridge: Record<string, unknown> | null = null;
  let bridgeError: string | null = null;
  if (delivery) {
    try {
      bridge = await inspectBridgeSite(delivery.bridgeAlias) as Record<string, unknown>;
    } catch (error) {
      bridgeError = error instanceof Error ? error.message : "Bridge inspect failed";
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Research configuration"
        title="Guide the research"
        description="Set what the AI should investigate. It chooses the sources, queries, and subreddits."
        actions={
          <Link href={`/sites/${siteId}/research`} className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground">
            Back to Research
          </Link>
        }
      />
      <section className="panel mb-5 p-5">
        <h2 className="font-heading text-lg font-semibold">Wix delivery</h2>
        {!delivery ? (
          <p className="mt-2 text-sm text-muted-foreground">No bridge delivery configuration is set for this site.</p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Fact label="Bridge alias" value={delivery.bridgeAlias} />
            <Fact label="Adapters" value={Array.isArray(delivery.adapters) ? delivery.adapters.join(", ") : "—"} />
            <Fact label="Status" value={bridgeError ? "unavailable" : "connected"} />
          </div>
        )}
        {bridgeError && <p className="mt-2 text-xs text-warning">{bridgeError}</p>}
        {bridge && (
          <p className="mt-2 font-data text-[10px] text-muted-foreground">
            {String((bridge.target as Record<string, unknown> | undefined)?.siteId ?? "")} · {String(bridge.customEmbedsAuth ?? "")} · {String(bridge.wixCli ?? "")}
          </p>
        )}
      </section>

      <ResearchConfigForm
        siteId={siteId}
        initial={{
          topics: config.topics,
          audience: config.audience,
          market: config.market,
          language: config.language,
          providers: config.providers,
          cadence: config.cadence as "daily" | "weekly" | "monthly" | "manual",
          enabled: config.enabled,
          maxSources: config.maxSources,
          monthlyBudget: config.monthlyBudget,
          autoDraft: config.autoDraft,
          autoAgent: config.autoAgent,
        }}
      />
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
