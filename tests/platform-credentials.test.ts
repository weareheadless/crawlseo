import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

vi.mock("@/lib/encryption", () => ({
  encryptCredential: vi.fn((value: string) => `encrypted:${value}`),
}));

import { encryptCredential } from "@/lib/encryption";
import {
  DATAFORSEO_PROVIDER,
  PLATFORM_DATAFORSEO_LABEL,
  ensurePlatformDataForSeoCredential,
  getPlatformDataForSeoCredentials,
} from "@/lib/dataforseo/platform-credentials";

const originalLogin = process.env.CRAWLSEO_DATAFORSEO_LOGIN;
const originalPassword = process.env.CRAWLSEO_DATAFORSEO_PASSWORD;

afterEach(() => {
  if (originalLogin === undefined) delete process.env.CRAWLSEO_DATAFORSEO_LOGIN;
  else process.env.CRAWLSEO_DATAFORSEO_LOGIN = originalLogin;
  if (originalPassword === undefined) delete process.env.CRAWLSEO_DATAFORSEO_PASSWORD;
  else process.env.CRAWLSEO_DATAFORSEO_PASSWORD = originalPassword;
  vi.mocked(encryptCredential).mockClear();
});

describe("platform DataForSEO credentials", () => {
  it("does not enable platform credentials when neither variable is set", () => {
    delete process.env.CRAWLSEO_DATAFORSEO_LOGIN;
    delete process.env.CRAWLSEO_DATAFORSEO_PASSWORD;

    expect(getPlatformDataForSeoCredentials()).toBeNull();
  });

  it("requires the login and API password as a pair", () => {
    process.env.CRAWLSEO_DATAFORSEO_LOGIN = "platform-login";
    delete process.env.CRAWLSEO_DATAFORSEO_PASSWORD;

    expect(() => getPlatformDataForSeoCredentials()).toThrow(
      "CRAWLSEO_DATAFORSEO_LOGIN and CRAWLSEO_DATAFORSEO_PASSWORD must be configured together"
    );
  });

  it("upserts one encrypted platform credential for provisioning", async () => {
    process.env.CRAWLSEO_DATAFORSEO_LOGIN = " platform-login ";
    process.env.CRAWLSEO_DATAFORSEO_PASSWORD = " platform-password ";
    const upsert = vi.fn().mockResolvedValue({ id: "provider-credential-1" });
    const tx = {
      providerCredential: { upsert },
    } as unknown as Prisma.TransactionClient;

    await expect(ensurePlatformDataForSeoCredential(tx)).resolves.toBe(
      "provider-credential-1"
    );
    expect(upsert).toHaveBeenCalledWith({
      where: {
        provider_label: {
          provider: DATAFORSEO_PROVIDER,
          label: PLATFORM_DATAFORSEO_LABEL,
        },
      },
      create: {
        provider: DATAFORSEO_PROVIDER,
        label: PLATFORM_DATAFORSEO_LABEL,
        encryptedLogin: "encrypted:platform-login",
        encryptedPassword: "encrypted:platform-password",
        status: "ACTIVE",
      },
      update: {
        encryptedLogin: "encrypted:platform-login",
        encryptedPassword: "encrypted:platform-password",
        status: "ACTIVE",
      },
      select: { id: true },
    });
  });
});
