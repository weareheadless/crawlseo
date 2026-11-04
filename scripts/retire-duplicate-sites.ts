/**
 * Retire duplicate site records that split one tenant (plan P7/P9).
 *
 *   npx tsx scripts/retire-duplicate-sites.ts            # report only
 *   npx tsx scripts/retire-duplicate-sites.ts --apply
 *
 * A project with two live site rows splits its history: the crawl lands on one,
 * research on the other, and the monthly cycle analyses the same tenant twice. The
 * rule is generic — one live site per project, preferring the real domain over a
 * workers.dev preview — so it applies to every tenant without a target list.
 *
 * Retiring keeps the row (and any audit history) and excludes it from analysis;
 * nothing is deleted.
 */
import { PrismaClient } from "@prisma/client";

function preference(domain: string, createdAt: Date): [number, number] {
  // Real domains before preview deployments, then the older record.
  return [domain.includes("workers.dev") ? 1 : 0, createdAt.getTime()];
}

async function main() {
  const db = new PrismaClient();
  const apply = process.argv.includes("--apply");
  const sites = await db.site.findMany({
    where: { retiredAt: null, projectId: { not: null } },
    select: { id: true, domain: true, projectId: true, createdAt: true, _count: { select: { crawls: true } } },
    orderBy: { createdAt: "asc" },
  });

  const byProject = new Map<string, typeof sites>();
  for (const site of sites) {
    byProject.set(site.projectId!, [...(byProject.get(site.projectId!) ?? []), site]);
  }

  let retired = 0;
  for (const [projectId, group] of byProject) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => {
      const [ap, at] = preference(a.domain, a.createdAt);
      const [bp, bt] = preference(b.domain, b.createdAt);
      return ap - bp || at - bt;
    });
    const [keep, ...duplicates] = ordered;
    process.stdout.write(`\nproject ${projectId}\n  keep  ${keep.domain} (${keep._count.crawls} crawls)\n`);
    for (const duplicate of duplicates) {
      process.stdout.write(`  retire ${duplicate.domain} (${duplicate._count.crawls} crawls)\n`);
      if (!apply) continue;
      await db.site.update({ where: { id: duplicate.id }, data: { retiredAt: new Date() } });
      retired += 1;
    }
  }

  process.stdout.write(
    apply ? `\nretired ${retired} duplicate site record(s)\n` : `\ndry run: ${byProject.size} project(s) inspected, nothing changed\n`
  );
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
