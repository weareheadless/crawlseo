import { beforeEach, describe, expect, it, vi } from "vitest";
const findFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { site: { findFirst } } }));
import { requireConnectorSite } from "@/lib/connectors/service";
const principal = { credentialId: "credential", servicePrincipalId: "relay", workspaceId: "workspace", projectId: "project", scopes: ["connector:read"] };

describe("current connector tenant binding", () => {
  beforeEach(() => vi.resetAllMocks());
  it("scopes the site to an active project and workspace", async () => {
    findFirst.mockResolvedValue({ id: "site", connectorBinding: { status: "ACTIVE" } });
    await requireConnectorSite(principal, "site");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: "site", projectId: "project", retiredAt: null,
      project: { workspaceId: "workspace", status: "ACTIVE", workspace: { status: "ACTIVE" } },
    } }));
  });
  it("rejects unavailable sites or inactive bindings", async () => {
    findFirst.mockResolvedValue(null);
    await expect(requireConnectorSite(principal, "other-site")).rejects.toMatchObject({ status: 404 });
    findFirst.mockResolvedValue({ id: "site", connectorBinding: { status: "SUSPENDED" } });
    await expect(requireConnectorSite(principal, "site")).rejects.toMatchObject({ status: 409 });
  });
});
