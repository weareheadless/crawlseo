import { loadEnvConfig } from "@next/env";

import { db } from "@/lib/db";
import { deliverWixPageComponent } from "@/lib/delivery/wix-early-packet";

loadEnvConfig(process.cwd());

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function main() {
  const taskId = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!taskId) throw new Error("usage: repair-wix-page <taskId> [--apply]");

  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, siteId: true, kind: true, status: true, route: true, result: true },
  });
  if (!task) throw new Error(`Agent task ${taskId} not found`);
  if (task.kind !== "wix_page") throw new Error(`Agent task ${taskId} is ${task.kind}, not a Wix page task`);

  const delivery = record(record(task.result).delivery);
  const variants = Array.isArray(delivery.variants) ? delivery.variants.map(record) : [];
  if (delivery.mode !== "component" || variants.length === 0) {
    throw new Error("This task was not delivered as a packet plus mount");
  }

  if (!apply) {
    console.log(JSON.stringify({
      taskId,
      status: task.status,
      variants: variants.map((variant) => ({
        route: variant.route,
        tag: variant.tag,
        mount: variant.mount,
        packets: variant.packets,
      })),
    }, null, 2));
    return;
  }

  const multiLocale = variants.length > 1;
  const repaired: Array<Record<string, unknown>> = [];
  for (const variant of variants) {
    const route = String(variant.route ?? "");
    const code = String(variant.code ?? "default");
    const kind = multiLocale && variant.isDefault !== true ? `page_html:${code}` : "page_html";
    const artifact = await db.agentTaskArtifact.findFirst({
      where: { taskId, kind },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });
    if (!artifact?.content) throw new Error(`No ${kind} artifact for ${route}`);

    const delivered = await deliverWixPageComponent({
      siteId: task.siteId,
      route,
      html: artifact.content,
      taskId,
      localeCode: variant.isDefault === true ? null : code,
      query: (variant.query as { key: string; value: string } | null) ?? null,
      excludeQuery: (variant.excludeQuery as { key: string; value: string } | null) ?? null,
      alternateRoute: (variant.alternateRoute as string | null) ?? null,
    });
    repaired.push({
      ...variant,
      tag: delivered.tag,
      packets: delivered.packets,
      mount: delivered.mount,
      placement: delivered.placement,
    });
    console.log(JSON.stringify({
      route: delivered.route,
      tag: delivered.tag,
      packets: delivered.packets,
      mount: delivered.mount,
      disabled: delivered.disabled,
      placement: delivered.placement,
    }, null, 2));
  }

  await db.agentTask.update({
    where: { id: taskId },
    data: {
      result: {
        ...record(task.result),
        delivery: { ...delivery, variants: repaired },
        repair: {
          at: new Date().toISOString(),
          by: "repair-wix-page",
          note: "Entries regenerated with reload-on-every-page and order-safe chunks",
        },
      } as never,
    },
  });
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await db.$disconnect();
    process.exitCode = 1;
  });
