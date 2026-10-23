import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

export type ResearchConfigInput = {
  topics: string[];
  audience?: string;
  market?: string;
  language: string;
  providers: string[];
  cadence: "daily" | "weekly" | "monthly" | "manual";
  enabled: boolean;
  maxSources: number;
  monthlyBudget: number;
  autoDraft: boolean;
  autoAgent: boolean;
};

export async function getResearchConfig(siteId: string) {
  const [profile, policy] = await Promise.all([
    db.siteProfile.findUnique({ where: { siteId } }),
    db.researchPolicy.findUnique({ where: { siteId } }),
  ]);
  const constraints = profile?.constraints && typeof profile.constraints === "object" && !Array.isArray(profile.constraints)
    ? profile.constraints as Record<string, unknown>
    : {};
  return {
    profile,
    policy,
    topics: stringList(profile?.topics),
    providers: stringList(policy?.providers).length > 0 ? stringList(policy?.providers) : ["reddit", "news"],
    audience: typeof profile?.audience === "string" ? profile.audience : "",
    market: typeof constraints.market === "string" ? constraints.market : "",
    language: profile?.language ?? "en",
    cadence: policy?.cadence ?? "weekly",
    enabled: policy?.enabled ?? true,
    maxSources: policy?.maxSources ?? 30,
    monthlyBudget: policy?.monthlyBudget ?? 9,
    autoDraft: policy?.autoDraft ?? false,
    autoAgent: policy?.autoAgent ?? false,
  };
}

export async function saveResearchConfig(siteId: string, input: ResearchConfigInput) {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, projectId: true } });
  if (!site) throw new Error("Site not found");

  await db.siteProfile.upsert({
    where: { siteId },
    create: {
      siteId,
      projectId: site.projectId,
      language: input.language,
      topics: json(input.topics),
      audience: input.audience ? json(input.audience) : undefined,
      constraints: input.market ? json({ market: input.market }) : undefined,
    },
    update: {
      language: input.language,
      topics: json(input.topics),
      audience: input.audience ? json(input.audience) : Prisma.JsonNull,
      constraints: input.market ? json({ market: input.market }) : Prisma.JsonNull,
    },
  });

  return db.researchPolicy.upsert({
    where: { siteId },
    create: {
      siteId,
      enabled: input.enabled,
      cadence: input.cadence,
      providers: json(input.providers),
      maxSources: input.maxSources,
      monthlyBudget: input.monthlyBudget,
      autoDraft: input.autoDraft,
      autoAgent: input.autoAgent,
    },
    update: {
      enabled: input.enabled,
      cadence: input.cadence,
      providers: json(input.providers),
      maxSources: input.maxSources,
      monthlyBudget: input.monthlyBudget,
      autoDraft: input.autoDraft,
      autoAgent: input.autoAgent,
    },
  });
}
