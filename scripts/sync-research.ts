import { loadEnvConfig } from "@next/env";
import { db } from "@/lib/db";
import { createResearchRun } from "@/lib/research/service";

loadEnvConfig(process.cwd());

const DAY = 24 * 60 * 60 * 1000;

function intervalMs(cadence: string): number | null {
  if (cadence === "daily") return DAY;
  if (cadence === "weekly") return 7 * DAY;
  if (cadence === "monthly") return 30 * DAY;
  return null;
}

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
      researchPolicy: true,
      siteProfile: true,
    },
  });

  const results = [];
  for (const site of sites) {
    const policy = site.researchPolicy;
    const profile = site.siteProfile;
    if (!policy || !profile) continue;
    const cadenceMs = intervalMs(policy.cadence);
    const topics = stringList(profile.topics);
    if (!cadenceMs || topics.length === 0) {
      results.push({ site: site.domain, status: "skipped", reason: "manual cadence or no topics" });
      continue;
    }
    const latest = await db.researchRun.findFirst({
      where: { siteId: site.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (latest && Date.now() - latest.createdAt.getTime() < cadenceMs) {
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
          recencyDays: 90,
          providers: stringList(policy.providers).length > 0
            ? stringList(policy.providers) as Array<"reddit" | "news" | "web">
            : ["reddit", "news"],
        },
        site.userId ?? "research-scheduler",
      );
      results.push({ site: site.domain, status: "queued", runId: run.id });
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
