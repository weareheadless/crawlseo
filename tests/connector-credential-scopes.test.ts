import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ site: { findFirst: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mocks }));
import { connectorCapabilities } from "@/lib/connectors/service";

describe("connector credential scope discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.site.findFirst.mockResolvedValue({
      id: "site-1", projectId: "project-1", project: { id: "project-1" },
      connectorBinding: { executor: "helloada", generation: 1, status: "ACTIVE" },
    });
  });

  it("distinguishes a read credential from supported backend write operations", async () => {
    const principal = { credentialId: "credential-1", servicePrincipalId: "principal-1",
      workspaceId: "workspace-1", projectId: "project-1", scopes: ["connector:read"] };
    const result = await connectorCapabilities(principal, "site-1");
    expect(result.credentialScopes).toEqual(["connector:read"]);
    expect(result.capabilities).toContain("context.write");
    expect(mocks.site.findFirst.mock.calls[0][0].where).toEqual({ projectId: "project-1", id: "site-1" });
  });

  it("reports the exact deduplicated runtime scopes without broadening them", async () => {
    const result = await connectorCapabilities({ credentialId: "credential-2", servicePrincipalId: "principal-1",
      workspaceId: "workspace-1", projectId: "project-1", scopes: ["connector:write", "connector:read", "connector:write"] }, "site-1");
    expect(result.credentialScopes).toEqual(["connector:read", "connector:write"]);
  });
});
