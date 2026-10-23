import { loadEnvConfig } from "@next/env";
import { db } from "@/lib/db";
import { syncSeoOpportunitiesToActions } from "@/lib/research/seo-actions";

loadEnvConfig(process.cwd());

async function main() {
  const sites = await db.site.findMany({
    select: { id: true, domain: true },
    orderBy: { domain: "asc" },
  });
  const results = [];
  for (const site of sites) {
    try {
      const result = await syncSeoOpportunitiesToActions(site.id);
      results.push({ site: site.domain, ...result });
    } catch (error) {
      results.push({
        site: site.domain,
        error: error instanceof Error ? error.message : "failed",
      });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
