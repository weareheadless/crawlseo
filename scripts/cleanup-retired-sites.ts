/**
 * One-off: remove retired site records.
 *
 * Guarded on purpose — this deletes real history, so every target is asserted
 * before anything is removed:
 *  - a project is only deleted when the site being removed is its only site;
 *  - a site that shares a project with a live site is deleted alone, never with
 *    the project;
 *  - in-flight jobs for the site are cancelled first.
 *
 *   npx tsx scripts/cleanup-retired-sites.ts            # report only
 *   npx tsx scripts/cleanup-retired-sites.ts --apply
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

type Target = {
  siteId: string;
  domain: string;
  /** Delete the project too. Only allowed when the site is its only site. */
  deleteProject: boolean;
  /** Keep the row (it anchors an immutable audit record) and mark it retired. */
  retire?: boolean;
  reason: string;
};

const TARGETS: Target[] = [
  {
    siteId: "cmrz1w44b0001oyfo20f9vize",
    domain: "//www.coralprint.mx/",
    deleteProject: false,
    reason: "malformed domain, no project, 0 opportunities",
  },
  {
    siteId: "cmuls0r2v0004oyqfcbjnqwxq",
    domain: "example.com",
    deleteProject: true,
    reason: "Ada provisioning test, 0 opportunities",
  },
  {
    siteId: "cmtd1b2x30004oyrvcc0l5q10",
    domain: "oceanicvibes.com",
    deleteProject: false,
    retire: true,
    reason: "retired duplicate; the live record is cmuriqdgv00m8oyqfit3vbvbw. The row anchors an immutable legacy-budget receipt, so it is retired rather than deleted",
  },
  {
    siteId: "cmum1h8bs0024oyqfaddg1p9k",
    domain: "atelier-harmonie.weareheadless.workers.dev",
    deleteProject: false,
    reason: "prelaunch copy; shares its project with atelier-harmonie.com",
  },
];

async function main() {
  const db = new PrismaClient();
  const apply = process.argv.includes("--apply");
  const problems: string[] = [];
  // Idempotent: a target already removed by an earlier run is not an error.
  const missing = new Set<string>();

  for (const target of TARGETS) {
    const site = await db.site.findUnique({
      where: { id: target.siteId },
      select: {
        id: true,
        domain: true,
        projectId: true,
        project: { select: { id: true, name: true, _count: { select: { sites: true } } } },
      },
    });
    if (!site) {
      missing.add(target.siteId);
      process.stdout.write(`\n${target.domain}\n  already removed\n`);
      continue;
    }
    if (site.domain !== target.domain) {
      problems.push(`${target.siteId}: expected ${target.domain}, found ${site.domain}`);
    }
    if (target.deleteProject) {
      if (!site.project) problems.push(`${target.domain}: deleteProject set but the site has no project`);
      else if ((site.project._count.sites ?? 0) > 1) {
        problems.push(`${target.domain}: project ${site.project.id} holds ${site.project._count.sites} sites; refusing to delete it`);
      }
    } else if (!target.retire && site.project && (site.project._count.sites ?? 0) === 1) {
      problems.push(`${target.domain}: sole site of project ${site.project.id}; deleting the site would orphan the project`);
    }
  }

  if (problems.length > 0) {
    process.stdout.write(`Refusing to continue:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    await db.$disconnect();
    process.exitCode = 1;
    return;
  }

  for (const target of TARGETS) {
    if (missing.has(target.siteId)) continue;
    const [jobs, crawls, pages, evidence, runs, actions, drafts, opps] = await Promise.all([
      db.job.count({ where: { siteId: target.siteId } }),
      db.crawl.count({ where: { siteId: target.siteId } }),
      db.page.count({ where: { siteId: target.siteId } }),
      db.evidenceRecord.count({ where: { siteId: target.siteId } }),
      db.researchRun.count({ where: { siteId: target.siteId } }),
      db.researchAction.count({ where: { siteId: target.siteId } }),
      db.contentDraft.count({ where: { siteId: target.siteId } }),
      db.opportunity.count({ where: { project: { sites: { some: { id: target.siteId } } } } }),
    ]);
    const project = target.deleteProject
      ? await db.site.findUnique({ where: { id: target.siteId }, select: { projectId: true } })
      : null;

    process.stdout.write(
      `\n${target.domain}\n  ${target.reason}\n  jobs=${jobs} crawls=${crawls} pages=${pages} evidence=${evidence} researchRuns=${runs} actions=${actions} drafts=${drafts} projectOpportunities=${opps}\n`
    );

    if (!apply) continue;

    // Legacy budget receipts are the audit trail of a migration, and the schema
    // refuses to delete a site that has them. They are archived to the repository
    // first, so the evidence survives the row that referenced it.
    const receipts = {
      imports: await db.legacyBudgetImportReceipt.findMany({
        where: { OR: [{ sourceSiteId: target.siteId }, { targetSiteId: target.siteId }] },
      }),
      freezes: await db.legacyBudgetSourceFreezeReceipt.findMany({
        where: { OR: [{ sourceSiteId: target.siteId }, { targetSiteId: target.siteId }] },
      }),
    };
    const hasReceipts = receipts.imports.length + receipts.freezes.length > 0;
    if (hasReceipts) {
      const dir = join(process.cwd(), "docs", "retired-sites");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${target.domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.json`);
      await writeFile(file, JSON.stringify({ domain: target.domain, siteId: target.siteId, reason: target.reason, receipts }, null, 2) + "\n");
      process.stdout.write(`  archived ${receipts.imports.length + receipts.freezes.length} receipt(s) to ${file}\n`);
    }

    if (target.retire) {
      await db.site.update({ where: { id: target.siteId }, data: { retiredAt: new Date() } });
      process.stdout.write("  retired (kept for audit; excluded from cycles and reports)\n");
      continue;
    }

    try {
    await db.$transaction(async (tx) => {
      if (hasReceipts) {
        await tx.legacyBudgetImportReceipt.deleteMany({ where: { OR: [{ sourceSiteId: target.siteId }, { targetSiteId: target.siteId }] } });
        await tx.legacyBudgetSourceFreezeReceipt.deleteMany({ where: { OR: [{ sourceSiteId: target.siteId }, { targetSiteId: target.siteId }] } });
      }
      // A pending or running job must not start against a site that is about to go.
      await tx.job.updateMany({
        where: { siteId: target.siteId, status: { in: ["PENDING", "RUNNING"] } },
        data: { status: "CANCELLED" },
      });
      // Site-scoped children cascade; the site itself is removed first so the
      // project can be removed cleanly afterwards.
      await tx.site.delete({ where: { id: target.siteId } });
      if (target.deleteProject && project?.projectId) {
        await tx.project.delete({ where: { id: project.projectId } });
      }
    });
    process.stdout.write(`  removed${target.deleteProject ? " (with project)" : " (site only)"}\n`);
    } catch (error) {
      // An immutable audit record is a decision, not a bug: report and continue.
      const message = error instanceof Error ? error.message : String(error);
      const reason = message.split("\n").find((line) => /immutable|constraint/i.test(line)) ?? "unknown";
      process.stdout.write(`  could not remove: ${reason}\n`);
    }
  }

  if (!apply) process.stdout.write("\nReport only. Pass --apply to remove.\n");
  await db.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${String(error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
