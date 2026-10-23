import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { ensureDefaultAlerts } from "@/lib/alerts/evaluate";
import { PageHeader } from "@/components/ui/page-header";
import { EvaluateAlertsButton } from "@/components/sites/evaluate-alerts-button";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function AlertsPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site) redirect("/sites");

  await ensureDefaultAlerts(userId, siteId);

  const alerts = await db.alert.findMany({
    where: { userId, siteId },
    orderBy: { type: "asc" },
  });

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Alerts"
        description="Rules for traffic drops, position changes, crawl health, and vitals"
        actions={<EvaluateAlertsButton />}
      />

      <div className="panel divide-y divide-border/50">
        {alerts.map((a) => (
          <div
            key={a.id}
            className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="font-medium text-foreground">
                {a.type.replaceAll("_", " ")}
              </p>
              <p className="text-xs text-muted-foreground">
                Channel: {a.channel}
                {a.lastFired
                  ? ` · last fired ${new Date(a.lastFired).toLocaleString()}`
                  : " · never fired"}
              </p>
              <p className="mt-1 font-data text-[11px] text-muted-foreground">
                {JSON.stringify(a.config)}
              </p>
            </div>
            <span
              className={
                a.enabled
                  ? "rounded-md bg-signal-muted px-2 py-1 text-xs font-semibold text-signal"
                  : "rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
              }
            >
              {a.enabled ? "Enabled" : "Off"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
