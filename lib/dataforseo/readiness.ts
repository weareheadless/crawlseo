import { db } from "@/lib/db";
import { getPlatformDataForSeoCredentials } from "@/lib/dataforseo/platform-credentials";

export type DataForSeoReadiness = { configured: boolean; source: "project" | "platform" | "legacy" | "none"; projectId: string | null };

export async function resolveDataForSeoReadiness(input: { projectId: string | null; userId: string }) : Promise<DataForSeoReadiness> {
  if (input.projectId) {
    const grant = await db.projectApiKeyGrant.findFirst({
      where: { projectId: input.projectId, provider: "dataforseo", status: "ACTIVE" },
      select: { apiKey: { select: { id: true } }, providerCredential: { select: { id: true, status: true } } },
    });
    if (grant && (grant.apiKey || grant.providerCredential?.status === "ACTIVE")) return { configured: true, source: "project", projectId: input.projectId };
  }
  try {
    if (getPlatformDataForSeoCredentials()) return { configured: true, source: "platform", projectId: input.projectId };
  } catch { /* Incomplete platform configuration is not a usable credential. */ }
  // One workspace keeps one key per provider. Which account stored it is not a
  // boundary: the operator who signed in may be a different account than the
  // one that added the key.
  const legacy = await db.apiKey.findFirst({
    where: { provider: "dataforseo" },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  return legacy ? { configured: true, source: "legacy", projectId: input.projectId } : { configured: false, source: "none", projectId: input.projectId };
}
