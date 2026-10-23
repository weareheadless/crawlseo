import { db } from "@/lib/db";

export type DeliveryAdapterName = "wix_embed" | "wix_blog" | "manual";

export async function getSiteDeliveryConfig(siteId: string) {
  return db.siteDeliveryConfig.findUnique({ where: { siteId } });
}

export async function saveSiteDeliveryConfig(
  siteId: string,
  input: { bridgeAlias: string; adapters: DeliveryAdapterName[]; enabled?: boolean },
) {
  const adapters = input.adapters.filter((adapter, index, all) => all.indexOf(adapter) === index);
  return db.siteDeliveryConfig.upsert({
    where: { siteId },
    create: {
      siteId,
      bridgeAlias: input.bridgeAlias.trim(),
      adapters,
      enabled: input.enabled ?? true,
    },
    update: {
      bridgeAlias: input.bridgeAlias.trim(),
      adapters,
      enabled: input.enabled ?? true,
    },
  });
}
