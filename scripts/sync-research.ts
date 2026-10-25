import { loadEnvConfig } from "@next/env";
import { db } from "@/lib/db";
import { createResearchRun } from "@/lib/research/service";
import { normalizeResearchCadence } from "@/lib/research/policy";
import { researchCadenceWindow } from "@/lib/research/schedule";
import { isSupersededByExternalAuthority } from "@/lib/research/execution-authority";

loadEnvConfig(process.cwd());

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

async function main() {
  const sites = await db.site.findMany({
    where: {
      researchPolicy: { enabled: true },
      siteProfile: { isNot: null },
    },
    select: {
      id: true,
      domain: true,
      userId: true,
      project: { select: { researchBudgetTimeZone: true } },
      researchPolicy: true,
      siteProfile: true,
    },
  });

  const results = [];
  for (const site of sites) {
    const policy = site.researchPolicy;
    const profile = site.siteProfile;
    if (!policy || !profile) continue;
    if (await isSupersededByExternalAuthority(site.id)) {
      results.push({ site: site.domain, status: "skipped", reason: "superseded_by_external_authority" });
      continue;
    }
    const cadence = normalizeResearchCadence(policy.cadence);
    const topics = stringList(profile.topics);
    if (cadence === "manual" || topics.length === 0) {
      results.push({ site: site.domain, status: "skipped", reason: "manual cadence or no topics" });
      continue;
    }
    const timeZone = site.project?.researchBudgetTimeZone ?? "UTC";
    const window = researchCadenceWindow(cadence, new Date(), timeZone);
    const latest = await db.researchRun.findFirst({
      where: { siteId: site.id, createdAt: { gte: window.start, lt: window.end } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (latest) {
      results.push({ site: site.domain, status: "skipped", reason: "within cadence" });
      continue;
    }
    try {
      const run = await createResearchRun(
        site.id,
        {
          title: "Scheduled market research",
          kind: "MARKET",
          trigger: "SCHEDULED",
          topics,
          audience: typeof profile.audience === "string" ? profile.audience : undefined,
          market: profile.constraints && typeof profile.constraints === "object" && !Array.isArray(profile.constraints)
            ? String((profile.constraints as Record<string, unknown>).market ?? "") || undefined
            : undefined,
          language: profile.language || "en",
          questions: [],
          recencyDays: policy.recencyDays ?? 90,
          providers: stringList(policy.providers).length > 0
            ? stringList(policy.providers) as Array<"reddit" | "news" | "web">
            : ["reddit", "news"],
        },
        site.userId ?? "research-scheduler",
        window.key,
      );
      results.push({ site: site.domain, status: run.status.toLowerCase(), runId: run.id });
    } catch (error) {
      results.push({ site: site.domain, status: "failed", error: error instanceof Error ? error.message : "failed" });
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
