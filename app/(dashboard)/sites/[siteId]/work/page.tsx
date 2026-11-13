import Link from "next/link";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { listTasks, listOpportunities } from "@/lib/funnel/views";
import { canAccessSite } from "@/lib/site/access";
import { OPPORTUNITY_LABELS } from "@/lib/funnel/labels";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Chip, ScoreBadge, StatusChip, VerdictChip, relativeTime } from "@/components/funnel/badges";
import { RefreshFunnelButton } from "@/components/funnel/refresh-button";
import type { TaskStatus } from "@prisma/client";

interface Props {
  params: Promise<{ siteId: string }>;
}

const STATE_ORDER: TaskStatus[] = ["todo", "in_progress", "awaiting_human", "delivered", "verified_outcome"];

const STATE_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  awaiting_human: "Awaiting you",
  delivered: "Delivered",
  verified_outcome: "Verified",
};

/**
 * Work (plan §5, surface 4): the human execution queue. Tasks exist only
 * because an opportunity was accepted, so every row shows its reason.
 */
export default async function WorkPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, domain: true, projectId: true } });
  if (!site || !canAccessSite(userId, site)) redirect("/sites");

  if (!site.projectId) {
    return (
      <div>
        <PageHeader eyebrow={site.domain} title="Work" description="Tasks created by accepting an opportunity." />
        <EmptyState
          title="This site is not attached to a project"
          description="Tasks belong to a project. Attach the site to a project to queue work."
          actionLabel="Open sites"
          actionHref="/sites"
        />
      </div>
    );
  }

  const [tasks, acceptedAll, deliveryTasks] = await Promise.all([
    listTasks(db, site.projectId),
    listOpportunities(db, { projectId: site.projectId, statuses: ["accepted", "in_progress"] }),
    db.agentTask.findMany({
      where: { siteId, status: { notIn: ["CLOSED", "COMPLETED", "CANCELLED"] } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, title: true, kind: true, status: true, route: true, publishedUrl: true },
    }),
  ]);
  // An accepted opportunity that already has a task is shown once, as the task.
  const taskedOpportunities = new Set(tasks.map((task) => task.opportunityId));
  const accepted = acceptedAll.filter((row) => !taskedOpportunities.has(row.id));

  const grouped = STATE_ORDER.map((state) => ({ state, rows: tasks.filter((task) => task.status === state) })).filter(
    (group) => group.rows.length > 0
  );

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Work"
        description="One queue. Every task came from an opportunity, so its reason is always one click away."
        actions={<RefreshFunnelButton siteId={siteId} />}
      />

      {deliveryTasks.length > 0 && (
        <section className="panel mb-5 overflow-hidden">
          <div className="border-b border-border/60 p-5">
            <h2 className="font-heading text-lg font-semibold">Delivery tasks</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Agent-prepared pages and articles. Open one to review the exact deliverable and confirm delivery once.
            </p>
          </div>
          <div className="divide-y divide-border/40">
            {deliveryTasks.map((task) => (
              <Link
                key={task.id}
                href={`/sites/${siteId}/agent-tasks/${task.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition hover:bg-muted/20"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{task.title}</p>
                  <p className="mt-0.5 font-data text-[10px] uppercase text-muted-foreground">
                    {task.kind === "wix_article" ? "Wix Blog article" : task.kind === "wix_page" ? "Wix page" : task.kind}
                    {task.route ? ` · ${task.route}` : ""}
                  </p>
                </div>
                <span className="rounded-md bg-muted px-1.5 py-0.5 font-data text-[10px] uppercase text-muted-foreground">
                  {task.status.toLowerCase().replaceAll("_", " ")}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {tasks.length === 0 && accepted.length === 0 && deliveryTasks.length === 0 ? (
        <EmptyState
          title="No tasks yet"
          description="Tasks are created by accepting an opportunity. Open the board, read the reason, and accept the ones worth playing."
          actionLabel="Open opportunities"
          actionHref={`/sites/${siteId}/opportunities`}
        />
      ) : (
        <div className="space-y-6">
          {accepted.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-2 font-heading text-atom-subheader font-semibold">
                Accepted, no task yet <Chip tone="primary">{accepted.length}</Chip>
              </h2>
              <ul className="space-y-2">
                {accepted.map((row) => (
                  <li key={row.id}>
                    <Link href={`/sites/${siteId}/opportunities/${row.id}`} className="panel flex items-center gap-3 px-4 py-2.5 transition hover:border-primary/40">
                      <span className="font-mono text-[11px] font-semibold text-primary">{OPPORTUNITY_LABELS[row.type].code}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.title}</span>
                      <ScoreBadge score={row.score} />
                      <span className="text-[11px] text-muted-foreground">create the task</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {grouped.map((group) => (
            <section key={group.state}>
              <h2 className="mb-2 flex items-center gap-2 font-heading text-atom-subheader font-semibold">
                {STATE_LABELS[group.state]} <Chip tone={group.state === "awaiting_human" ? "warning" : "neutral"}>{group.rows.length}</Chip>
              </h2>
              <ul className="space-y-2">
                {group.rows.map((task) => (
                  <li key={task.id}>
                    <Link
                      href={`/sites/${siteId}/opportunities/${task.opportunityId}`}
                      className="panel block px-4 py-3 transition hover:border-primary/40"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] font-semibold text-primary">
                          {OPPORTUNITY_LABELS[task.opportunityType].code}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{task.title}</span>
                        <StatusChip status={task.status} />
                        {task.verdict && <VerdictChip verdict={task.verdict} />}
                        <ScoreBadge score={task.opportunityScore} />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        <span>{OPPORTUNITY_LABELS[task.opportunityType].label}</span>
                        <span>· executor {task.assignedTo}</span>
                        {task.agentPreparedById && <span>· prepared by agent</span>}
                        {task.humanConfirmedBy && <span>· confirmed by {task.humanConfirmedBy}</span>}
                        <span>· {relativeTime(task.createdAt)}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
