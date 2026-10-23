import { loadEnvConfig } from "@next/env";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { bridgeRoot, readBridgeSnippet } from "@/lib/bridge/client";
import { resolveAgentTarget } from "@/lib/agent-tasks/targets";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";

loadEnvConfig(process.cwd());

const siteId = process.argv[2];
if (!siteId) throw new Error("usage: inventory-wix-delivery <siteId>");

function tagAndSource(source: string, file: string) {
  const match = source.match(/customElements\.define\(\s*["']([a-z0-9-]+)["']/i);
  return match?.[1] ? { tag: match[1], source: file } : null;
}

async function main() {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, domain: true } });
  if (!site) throw new Error("site not found");
  const delivery = await getSiteDeliveryConfig(siteId);
  if (!delivery) throw new Error("delivery config not found");
  const target = resolveAgentTarget(site.domain);
  if (!target) throw new Error("agent target not found");

  const sourceDir = path.join(target.repoPath, "src/public/custom-elements");
  const files = await readdir(sourceDir);
  const components = new Map<string, string>();
  for (const file of files.filter((name) => name.endsWith(".js"))) {
    const source = await readFile(path.join(sourceDir, file), "utf8");
    const found = tagAndSource(source, `src/public/custom-elements/${file}`);
    if (found) components.set(found.tag, found.source);
  }

  const manifest = JSON.parse(await readFile(path.join(bridgeRoot(), "sites", delivery.bridgeAlias, "site.manifest.json"), "utf8"));
  const snippetTags = new Map<string, { snippetId: string; name: string }>();
  for (const snippet of manifest.site?.customCode ?? []) {
    try {
      const response = await readBridgeSnippet(delivery.bridgeAlias, snippet.id) as {
        snippet?: { embedData?: { html?: string } };
      };
      const html = response.snippet?.embedData?.html ?? "";
      const matches = [...html.matchAll(/\[\s*["']([a-z0-9-]+)["']\s*,\s*["'][A-Za-z0-9+/=]{40,}/gi)];
      for (const match of matches) {
        snippetTags.set(match[1], { snippetId: snippet.id, name: snippet.name });
      }
    } catch {
      // Some snippets may be unavailable; the rest of the inventory remains useful.
    }
  }

  let mapped = 0;
  let unmapped = 0;
  for (const [tag, sourcePath] of components) {
    const packet = snippetTags.get(tag);
    await db.deliveryTarget.upsert({
      where: { siteId_key: { siteId, key: `embed:${tag}` } },
      create: {
        siteId,
        key: `embed:${tag}`,
        kind: "embed",
        adapter: "wix_embed",
        componentTag: tag,
        snippetId: packet?.snippetId ?? null,
        sourcePath,
        enabled: Boolean(packet),
        metadata: packet ? { snippetName: packet.name, packetFormat: "susi-early-registry" } : { missingPacket: true },
      },
      update: {
        adapter: "wix_embed",
        componentTag: tag,
        snippetId: packet?.snippetId ?? null,
        sourcePath,
        enabled: Boolean(packet),
        metadata: packet ? { snippetName: packet.name, packetFormat: "susi-early-registry" } : { missingPacket: true },
      },
    });
    if (packet) mapped += 1;
    else unmapped += 1;
  }

  console.log(JSON.stringify({
    site: site.domain,
    bridgeAlias: delivery.bridgeAlias,
    components: components.size,
    packetSnippets: snippetTags.size,
    mapped,
    unmapped,
    targets: [...snippetTags.entries()].map(([tag, packet]) => ({ tag, ...packet })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
