import type { Prisma } from "@prisma/client";
import { encryptCredential } from "@/lib/encryption";

export const DATAFORSEO_PROVIDER = "dataforseo";
export const PLATFORM_DATAFORSEO_LABEL = "crawlseo-platform";

export type PlatformDataForSeoCredentials = {
  login: string;
  password: string;
};

/** Read the single platform credential used for automatic project provisioning. */
export function getPlatformDataForSeoCredentials(): PlatformDataForSeoCredentials | null {
  const login = process.env.CRAWLSEO_DATAFORSEO_LOGIN?.trim() || "";
  const password = process.env.CRAWLSEO_DATAFORSEO_PASSWORD?.trim() || "";
  if (!login && !password) return null;
  if (!login || !password) {
    throw new Error(
      "CRAWLSEO_DATAFORSEO_LOGIN and CRAWLSEO_DATAFORSEO_PASSWORD must be configured together"
    );
  }
  return { login, password };
}

/** Upsert the encrypted platform credential inside the project transaction. */
export async function ensurePlatformDataForSeoCredential(
  tx: Prisma.TransactionClient
): Promise<string | null> {
  const credentials = getPlatformDataForSeoCredentials();
  if (!credentials) return null;

  const credential = await tx.providerCredential.upsert({
    where: {
      provider_label: {
        provider: DATAFORSEO_PROVIDER,
        label: PLATFORM_DATAFORSEO_LABEL,
      },
    },
    create: {
      provider: DATAFORSEO_PROVIDER,
      label: PLATFORM_DATAFORSEO_LABEL,
      encryptedLogin: encryptCredential(credentials.login),
      encryptedPassword: encryptCredential(credentials.password),
      status: "ACTIVE",
    },
    update: {
      encryptedLogin: encryptCredential(credentials.login),
      encryptedPassword: encryptCredential(credentials.password),
      status: "ACTIVE",
    },
    select: { id: true },
  });

  return credential.id;
}
