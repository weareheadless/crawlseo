import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { configurationSectionFields, mergeConstraints, type ConfigurationSection } from "@/lib/pipeline/configuration";

export class ConfigurationConflict extends Error { status = 409; }
export class ConfigurationPreconditionRequired extends Error { status = 428; }
export class InvalidConfigurationSection extends Error { status = 400; }

const providers = ["reddit", "news"];
const cadence = ["daily", "weekly", "monthly", "manual"];

function validate(section: ConfigurationSection, values: Record<string, unknown>) {
  const allowed = configurationSectionFields[section] as readonly string[];
  const keys = Object.keys(values);
  if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new InvalidConfigurationSection("Empty or unsupported field for section");
  for (const [key, value] of Object.entries(values)) {
    if (["topics", "goals", "services", "competitors", "exclusions", "providers"].includes(key)) {
      const limits: Record<string, number> = { topics: 12, goals: 12, services: 12, competitors: 12, exclusions: 12, providers: 2 };
      const maxLength = key === "exclusions" ? 120 : key === "providers" ? 20 : 120;
      const mayClear = ["goals", "services", "competitors", "exclusions"].includes(key);
      if (!Array.isArray(value) || (!mayClear && value.length < 1) || value.length > limits[key] || value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > maxLength)) throw new InvalidConfigurationSection(`Invalid ${key}`);
      if (key === "providers" && (value.length < 1 || value.some((item) => !providers.includes(item)))) throw new InvalidConfigurationSection("Unsupported provider");
    } else if (["audience", "market", "language", "brandVoice"].includes(key)) {
      const limits: Record<string, number> = { audience: 300, market: 120, language: 16, brandVoice: 500 };
      if (typeof value !== "string" || (key === "language" ? value.trim().length < 2 : false) || value.trim().length > limits[key]) throw new InvalidConfigurationSection(`Invalid ${key}`);
    } else if (key === "recencyDays" || key === "maxSources" || key === "monthlyBudget") {
      const bounds: Record<string, [number, number]> = { recencyDays: [1, 3650], maxSources: [1, 100], monthlyBudget: [0, 500] };
      const [min, max] = bounds[key];
      if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new InvalidConfigurationSection(`Invalid ${key}`);
    } else if (["enabled", "autoDraft", "autoAgent"].includes(key)) {
      if (typeof value !== "boolean") throw new InvalidConfigurationSection(`Invalid ${key}`);
    } else if (key === "cadence" && (typeof value !== "string" || !cadence.includes(value))) throw new InvalidConfigurationSection("Invalid cadence");
  }
}

export async function saveConfigurationSection(siteId: string, section: ConfigurationSection, values: Record<string, unknown>, expectedPolicyRevision?: number, expectedProfileUpdatedAt?: string | null) {
  values = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Array.isArray(value) ? value.map((entry) => typeof entry === "string" ? entry.trim() : entry) : typeof value === "string" ? value.trim() : value]));
  validate(section, values);
  const changesPolicy = Object.keys(values).some((key) => section !== "business" || key === "goals");
  const changesProfile = Object.keys(values).some((key) => section === "business" || key === "exclusions");
  if ((changesPolicy && expectedPolicyRevision === undefined) || (changesProfile && expectedProfileUpdatedAt === undefined)) throw new ConfigurationPreconditionRequired("Expected revision/timestamp required");

  let initialProfile: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const [policy, profile, site] = await Promise.all([
          tx.researchPolicy.findUnique({ where: { siteId } }),
          tx.siteProfile.findUnique({ where: { siteId } }),
          tx.site.findUnique({ where: { id: siteId }, select: { id: true, projectId: true } }),
        ]);
        if (!site) throw new InvalidConfigurationSection("Site not found");
        if (changesPolicy && (policy?.revision ?? 0) !== expectedPolicyRevision) throw new ConfigurationConflict("Research policy changed; reload before saving");
        const profileStamp = profile?.updatedAt.toISOString() ?? null;
        const profileRecord = profile as unknown as Record<string, unknown> | null;
        if (attempt === 0) initialProfile = profileRecord;
        if (changesProfile && profileStamp !== expectedProfileUpdatedAt) {
          const originalProfile = initialProfile;
          const changedKeys = Object.keys(values).filter((key) => ["topics", "audience", "language", "services", "competitors", "brandVoice"].includes(key));
          const constraintKeys = Object.keys(values).filter((key) => ["market", "goals", "exclusions"].includes(key));
          const sameTouchedValues = attempt > 0 && originalProfile !== null && changedKeys.every((key) => JSON.stringify(profileRecord?.[key] ?? null) === JSON.stringify(originalProfile[key] ?? null)) && constraintKeys.every((key) => {
            const current = mergeConstraints(profileRecord?.constraints, {});
            const initial = mergeConstraints(originalProfile.constraints, {});
            return JSON.stringify(current[key] ?? null) === JSON.stringify(initial[key] ?? null);
          });
          if (!sameTouchedValues) throw new ConfigurationConflict("Business context changed; reload before saving");
        }

        const profilePatch: Record<string, unknown> = {};
        const policyPatch: Record<string, unknown> = {};
        const constraintsPatch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(values)) {
          if (key === "topics" || key === "audience" || key === "language" || key === "services" || key === "competitors" || key === "brandVoice") profilePatch[key] = key === "audience" && value === "" ? Prisma.JsonNull : value;
          else if (key === "market" || key === "goals") constraintsPatch[key] = value;
          else policyPatch[key] = value;
        }
        if (Object.hasOwn(values, "goals")) policyPatch.goals = values.goals;
        if (Object.hasOwn(values, "exclusions")) {
          policyPatch.exclusions = values.exclusions;
          constraintsPatch.exclusions = values.exclusions;
        }
        let updatedProfile = profile;
        if (changesProfile) {
          const constraints = mergeConstraints(profile?.constraints, constraintsPatch);
          const data = { ...profilePatch, ...(Object.keys(constraintsPatch).length ? { constraints: constraints as Prisma.InputJsonValue } : {}) };
          updatedProfile = await tx.siteProfile.upsert({ where: { siteId }, create: { siteId, projectId: site.projectId, ...data } as Prisma.SiteProfileUncheckedCreateInput, update: data });
        }
        if (changesPolicy) {
          const data = { ...policyPatch, revision: { increment: 1 } } as Prisma.ResearchPolicyUpdateInput;
          if (policy) await tx.researchPolicy.update({ where: { siteId, revision: expectedPolicyRevision }, data });
          else await tx.researchPolicy.create({ data: { siteId, ...policyPatch, revision: 1 } as Prisma.ResearchPolicyUncheckedCreateInput });
        }
        return { ok: true, policyRevision: changesPolicy ? (policy?.revision ?? 0) + 1 : policy?.revision ?? 0, profileUpdatedAt: updatedProfile?.updatedAt?.toISOString() ?? null };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof ConfigurationConflict || error instanceof ConfigurationPreconditionRequired || error instanceof InvalidConfigurationSection) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2025")) throw new ConfigurationConflict("Configuration changed while saving; reload before saving");
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")) throw error;
      if (attempt === 2) throw new ConfigurationConflict("Configuration is changing concurrently; reload and try again");
    }
  }
  throw new ConfigurationConflict("Configuration is changing concurrently; reload and try again");
}
