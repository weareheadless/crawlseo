/**
 * Check one Wix static page for its own title and meta description, and fill
 * them from the page's copy when they are missing.
 *
 * A page pushed by CrawlSEO now gets this automatically; this script repairs a
 * page that was delivered before that check existed, or re-checks one a human
 * has edited. Read-only unless --apply is passed.
 *
 *   tsx scripts/repair-page-seo.ts atelier-harmonie --route /abat-jour-sur-mesure
 *   tsx scripts/repair-page-seo.ts atelier-harmonie --route /abat-jour-sur-mesure --apply
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { db } from "@/lib/db";
import { renderPageText } from "@/lib/delivery/wix-render";
import { ensurePageSeo, generatePageSeo, htmlToText, livePageSeo } from "@/lib/delivery/page-seo";
import { readBridgePageSeo } from "@/lib/bridge/client";

/** The URL the site actually serves, after its apex-to-www redirect. */
async function canonicalUrl(url: string): Promise<string> {
  try {
    const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0" } });
    return response.url || url;
  } catch {
    return url;
  }
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const siteAlias = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const route = option("--route");
  const apply = process.argv.includes("--apply");
  if (!siteAlias || !route) {
    console.error("Usage: tsx scripts/repair-page-seo.ts <bridge-alias> --route /page [--apply]");
    process.exit(2);
  }

  const config = await db.siteDeliveryConfig.findFirst({
    where: { bridgeAlias: siteAlias },
    select: { siteId: true, site: { select: { domain: true, siteProfile: { select: { language: true } } } } },
  });
  if (!config) {
    console.error(`No site uses the bridge alias ${siteAlias}.`);
    process.exit(2);
  }
  const domain = config.site.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const requested = `https://${domain}${route}`;
  // A headless dump of a redirecting URL can return the empty redirect shell,
  // so the rendered checks use the address the site actually serves.
  const url = await canonicalUrl(requested);
  const language = config.site.siteProfile?.language ?? "fr";

  const current = await readBridgePageSeo(siteAlias, route);
  const live = await livePageSeo(url);
  console.log(JSON.stringify({
    route,
    url,
    pageId: current.pageId,
    hasOwnTitleAndDescription: current.hasOverride === true,
    saved: { title: current.currentTitle ?? null, description: current.currentDescription ?? null },
    live,
  }, null, 2));

  if (!apply) {
    if (current.hasOverride && current.currentTitle && current.currentDescription) {
      console.log("The page already carries its own title and description.");
      return;
    }
    // The page body is injected by its component, so the raw document has no
    // copy; a rendered document is what a visitor and a crawler read.
    const text = htmlToText((await renderPageText(url)) ?? "");
    if (text.length < 80) {
      console.log("The live page has no readable copy yet; deliver the page first.");
      return;
    }
    const proposal = await generatePageSeo({ siteName: domain, language, route, pageTitle: null, text });
    console.log("Proposal (dry run, pass --apply to publish it):");
    console.log(JSON.stringify(proposal, null, 2));
    return;
  }

  const result = await ensurePageSeo({
    alias: siteAlias,
    route,
    url,
    siteName: domain,
    language,
    html: (await renderPageText(url)) ?? "",
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
