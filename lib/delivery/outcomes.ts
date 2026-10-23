import { db } from "@/lib/db";

const DAY = 24 * 60 * 60 * 1000;

function window(daysBackStart: number, daysBackEnd: number) {
  const now = Date.now();
  return {
    start: new Date(now - daysBackStart * DAY),
    end: new Date(now - daysBackEnd * DAY),
  };
}

async function pageMetrics(siteId: string, targetUrl: string | null, start: Date, end: Date) {
  const rows = await db.page.findMany({
    where: {
      siteId,
      date: { gte: start, lt: end },
      ...(targetUrl ? { url: targetUrl } : {}),
    },
    select: { clicks: true, impressions: true, position: true },
  });
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const position = impressions > 0
    ? rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions
    : 0;
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 10_000) / 100 : 0,
    position: Math.round(position * 10) / 10,
  };
}

export async function measureDeliveryOutcome(deliveryId: string) {
  const delivery = await db.delivery.findUnique({
    where: { id: deliveryId },
    include: {
      action: { select: { siteId: true, targetUrl: true, primaryQuery: true, title: true } },
    },
  });
  if (!delivery) throw new Error("Delivery not found");
  if (!delivery.action) throw new Error("Delivery is not linked to an action");
  const targetUrl = delivery.action.targetUrl || null;
  const currentWindow = window(28, 0);
  const previousWindow = window(56, 28);
  const [current, previous] = await Promise.all([
    pageMetrics(delivery.action.siteId, targetUrl, currentWindow.start, currentWindow.end),
    pageMetrics(delivery.action.siteId, targetUrl, previousWindow.start, previousWindow.end),
  ]);
  const outcome = {
    schema_version: 1,
    kind: targetUrl ? "gsc_page_28d" : "gsc_site_28d",
    target_url: targetUrl,
    current,
    previous,
    deltas: {
      clicks: current.clicks - previous.clicks,
      impressions: current.impressions - previous.impressions,
      ctr: Math.round((current.ctr - previous.ctr) * 100) / 100,
      position: Math.round((current.position - previous.position) * 10) / 10,
    },
    measured_at: new Date().toISOString(),
    note: "Descriptive GSC comparison, not causal attribution.",
  };
  return db.delivery.update({
    where: { id: deliveryId },
    data: { outcome, outcomeMeasuredAt: new Date() },
  });
}

export async function measurePendingDeliveryOutcomes() {
  const deliveries = await db.delivery.findMany({
    where: {
      status: "PUBLISHED",
      outcomeMeasuredAt: null,
      actionId: { not: undefined },
      createdAt: { lte: new Date(Date.now() - 28 * DAY) },
    },
    select: { id: true },
    take: 100,
  });
  const results = [];
  for (const delivery of deliveries) {
    try {
      const updated = await measureDeliveryOutcome(delivery.id);
      results.push({ id: delivery.id, status: "measured", outcome: updated.outcome });
    } catch (error) {
      results.push({ id: delivery.id, status: "failed", error: error instanceof Error ? error.message : "failed" });
    }
  }
  return results;
}
