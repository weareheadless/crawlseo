import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: { projectApiKeyGrant: { findFirst: vi.fn() }, apiKey: { findUnique: vi.fn() } } }));
vi.mock("@/lib/dataforseo/platform-credentials", () => ({ getPlatformDataForSeoCredentials: vi.fn() }));
import { db } from "@/lib/db";
import { getPlatformDataForSeoCredentials } from "@/lib/dataforseo/platform-credentials";
import { resolveDataForSeoReadiness } from "@/lib/dataforseo/readiness";
afterEach(() => vi.resetAllMocks());
describe("DataForSEO readiness", () => {
 it("uses an active project grant", async () => { vi.mocked(db.projectApiKeyGrant.findFirst).mockResolvedValue({ apiKey: { id: "k" }, providerCredential: null } as never); expect(await resolveDataForSeoReadiness({ projectId:"p",userId:"u" })).toMatchObject({ configured:true,source:"project" }); });
 it("uses platform credentials", async () => { vi.mocked(getPlatformDataForSeoCredentials).mockReturnValue({login:"l",password:"p"}); expect(await resolveDataForSeoReadiness({ projectId:null,userId:"u" })).toMatchObject({configured:true,source:"platform"}); });
 it("uses legacy key", async () => { vi.mocked(db.apiKey.findUnique).mockResolvedValue({id:"k"} as never); expect(await resolveDataForSeoReadiness({ projectId:null,userId:"u" })).toMatchObject({configured:true,source:"legacy"}); });
 it("reports none", async () => { vi.mocked(db.apiKey.findUnique).mockResolvedValue(null); expect(await resolveDataForSeoReadiness({ projectId:null,userId:"u" })).toMatchObject({configured:false,source:"none"}); });
});
