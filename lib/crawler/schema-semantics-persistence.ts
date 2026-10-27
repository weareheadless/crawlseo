import type { Prisma } from "@prisma/client";

type AuditIssue = { url: string; severity: "WARNING" | "INFO"; message: string; details: Record<string, unknown> };
type Store = {
  crawlIssue: {
    findFirst(args: { where: { crawlId: string; url: string; type: "MISSING_SCHEMA"; details: { path: string[]; equals: string } }; select: { id: true } }): Promise<{ id: string } | null>;
    create(args: { data: { crawlId: string; url: string; type: "MISSING_SCHEMA"; severity: "WARNING" | "INFO"; message: string; details: Prisma.InputJsonValue } }): Promise<unknown>;
    update(args: { where: { id: string }; data: { severity: "WARNING" | "INFO"; message: string; details: Prisma.InputJsonValue } }): Promise<unknown>;
    findMany(args: { where: { crawlId: string; type: "MISSING_SCHEMA"; details: { path: string[]; equals: string } }; select: { id: true; details: true } }): Promise<Array<{ id: string; details: unknown }>>;
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown>;
  };
};

/** Persist one current result per stable page/field key within the crawl run. */
export async function persistSchemaSemanticsIssues(store: Store, crawlId: string, issues: AuditIssue[]) {
  const currentKeys = new Set(issues.map(issue => String(issue.details.stableKey)));
  for (const issue of issues) {
    const stableKey = String(issue.details.stableKey);
    const existing = await store.crawlIssue.findFirst({ where: { crawlId, url: issue.url, type: "MISSING_SCHEMA", details: { path: ["stableKey"], equals: stableKey } }, select: { id: true } });
    const data = { severity: issue.severity, message: issue.message, details: issue.details as Prisma.InputJsonValue };
    if (existing) await store.crawlIssue.update({ where: { id: existing.id }, data });
    else await store.crawlIssue.create({ data: { crawlId, url: issue.url, type: "MISSING_SCHEMA", ...data } });
  }
  const prior = await store.crawlIssue.findMany({ where: { crawlId, type: "MISSING_SCHEMA", details: { path: ["kind"], equals: "business_schema_semantics" } }, select: { id: true, details: true } });
  const staleIds = prior.filter(row => !currentKeys.has(String((row.details as Record<string, unknown>).stableKey))).map(row => row.id);
  if (staleIds.length) await store.crawlIssue.deleteMany({ where: { id: { in: staleIds } } });
}
