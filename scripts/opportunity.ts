/**
 * Work the opportunity board from this host.
 *
 * The MCP surface (`mcp/http-server.ts`) is the right entry point for an agent connecting
 * from elsewhere: it authenticates, it scopes to one project, and it is reachable over the
 * network. But the common executor is a session already running *on this box*, beside the
 * site checkouts and the Wix bridge — and for that case a CLI is the better tool, for the
 * same reason `scripts/deliver-page.ts` is a CLI: the caller is local, the work happens
 * locally, and no credential has to be minted, stored or rotated to do it.
 *
 * This is a thin command over the same library functions the MCP tools call. It is not a
 * second implementation, so the rules cannot drift between the two lanes.
 *
 * Usage:
 *   tsx scripts/opportunity.ts list --project <id> [--status detected] [--limit 20]
 *   tsx scripts/opportunity.ts show <opportunityId>
 *   tsx scripts/opportunity.ts config
 *   tsx scripts/opportunity.ts accept <opportunityId> --by "<person>"
 *   tsx scripts/opportunity.ts park <opportunityId> --by "<person>" --reason "<why>"
 *   tsx scripts/opportunity.ts deliver <opportunityId> --by "<agent>" --note "<why>"
 *        [--commit <sha>] [--pr <url>] [--url <live url>] [--kind code_change]
 *        [--status in_progress]
 *
 * `--project` defaults to the only project if there is exactly one; with several it is
 * required, because guessing which tenant a piece of work belongs to is not a decision this
 * command should make.
 *
 * Every command prints one JSON object. Exit code is non-zero only when the command failed.
 */
import { loadEnvConfig } from "@next/env";
import { db } from "@/lib/db";
import { readOpportunityBoard, readWorkBrief } from "@/lib/opportunities/board";
import { decideOpportunityAsExecutor } from "@/lib/opportunities/decide";
import { readExecutionConfig, reportOpportunityWork } from "@/lib/opportunities/external-execution";
import { projectSite } from "@/lib/projects/project-site";

loadEnvConfig(process.cwd());

function value(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
function required(name: string): string {
  const found = value(name);
  if (!found) throw new Error(`${name} is required`);
  return found;
}

async function resolveProject(): Promise<{ projectId: string; domain: string; siteId: string }> {
  const explicit = value("--project");
  if (explicit) {
    const site = await projectSite(explicit);
    return { projectId: explicit, domain: site.domain, siteId: site.id };
  }
  const projects = await db.project.findMany({
    where: { status: "ACTIVE", sites: { some: { retiredAt: null } } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  if (projects.length === 1) {
    const site = await projectSite(projects[0].id);
    return { projectId: projects[0].id, domain: site.domain, siteId: site.id };
  }
  throw new Error(
    `--project <id> is required: ${projects.length} active projects\n`
    + projects.map((project) => `  ${project.id}  ${project.name}`).join("\n")
  );
}

async function main() {
  const command = process.argv[2];
  const target = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
  const project = await resolveProject();

  switch (command) {
    case "list": {
      const board = await readOpportunityBoard(db as never, project.projectId, {
        siteId: project.siteId,
        status: (value("--status") as never) ?? undefined,
        evidenceClass: (value("--class") as never) ?? undefined,
        limit: Number(value("--limit") ?? 20),
        cursor: value("--cursor") ?? undefined,
      });
      // A compact table, because the point of `list` is to choose a row to act on.
      for (const row of board.opportunities) {
        const score = String(row.score ?? "-").padStart(4);
        const cls = row.evidenceClass.slice(0, 4);
        const page = (row.pageUrl ?? "").replace(/^https?:\/\/[^/]+/, "") || "-";
        process.stdout.write(`${row.id}  ${score} ${cls.padEnd(5)} ${row.status.padEnd(11)} ${page.slice(0, 44)}\n`);
      }
      process.stdout.write(JSON.stringify({ ...project, counts: board.counts, nextCursor: board.nextCursor }) + "\n");
      return;
    }

    case "show": {
      if (!target) throw new Error("show <opportunityId> is required");
      process.stdout.write(JSON.stringify(await readWorkBrief(db as never, project.projectId, target), null, 2) + "\n");
      return;
    }

    case "config": {
      process.stdout.write(
        JSON.stringify(await readExecutionConfig(db as never, project.projectId, project.siteId), null, 2) + "\n"
      );
      return;
    }

    case "accept":
    case "park":
    case "reject": {
      if (!target) throw new Error(`${command} <opportunityId> is required`);
      const result = await decideOpportunityAsExecutor(db as never, project.projectId, {
        siteId: project.siteId,
        opportunityId: target,
        decision: command,
        decidedBy: required("--by"),
        reason: value("--reason") ?? undefined,
        expectedDecisionId: value("--decision-id") ?? null,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }

    case "deliver": {
      if (!target) throw new Error("deliver <opportunityId> is required");
      const result = await reportOpportunityWork(db as never, project.projectId, {
        siteId: project.siteId,
        opportunityId: target,
        executorId: required("--by"),
        workKind: (value("--kind") ?? "code_change") as "code_change",
        note: required("--note"),
        status: (value("--status") ?? "delivered") as "delivered",
        commitSha: value("--commit"),
        pullRequestUrl: value("--pr"),
        deployedUrl: value("--url"),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }

    default:
      throw new Error(
        "usage: opportunity.ts <list|show|config|accept|park|reject|deliver> [id] [--project] [--by] [--note] "
        + "[--reason] [--commit] [--pr] [--url] [--kind] [--status] [--limit] [--class]"
      );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
