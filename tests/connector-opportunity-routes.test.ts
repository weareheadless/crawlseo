import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn(), decide: vi.fn(), confirm: vi.fn(), task: vi.fn() }));
vi.mock("@/lib/connectors/auth", () => ({ connectorPrincipal: mocks.auth, isConnectorResponse: (auth: object) => "response" in auth }));
vi.mock("@/lib/connectors/opportunities", () => ({
  listConnectorOpportunities: mocks.list, operateOnOpportunity: mocks.decide, confirmConnectorTask: mocks.confirm, getConnectorTask: mocks.task,
}));
import { GET as list } from "@/app/api/connector/v1/opportunities/route";
import { POST as decide } from "@/app/api/connector/v1/opportunities/[opportunityId]/operations/route";
import { GET as task, POST as confirm } from "@/app/api/connector/v1/tasks/[taskId]/route";
import { ConnectorError } from "@/lib/connectors/service";

const principal = { projectId: "project" };
const params = { params: Promise.resolve({ taskId: "task" }) };
const confirmation = { siteId: "site", generation: 2, idempotencyKey: "key", confirmedBy: "owner",
  confirmationRef: "conversation/message", opportunityId: "op", expectedStatus: "delivered", status: "verified_outcome" };

describe("connector Opportunity/Task HTTP boundaries", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ principal }); });

  it("requires connector:read and an explicit site for listing", async () => {
    expect((await list(new Request("https://example.test/api/connector/v1/opportunities"))).status).toBe(400);
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "connector:read");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each([401, 403])("does not invoke a service for rejected authentication (%s)", async (status) => {
    mocks.auth.mockResolvedValue({ response: Response.json({ error: "Denied" }, { status }) });
    expect((await confirm(new Request("https://example.test/task", { method: "POST", body: JSON.stringify(confirmation) }), params)).status).toBe(status);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("forwards the exact owner-confirmed status and uses connector:write", async () => {
    mocks.confirm.mockResolvedValue({ status: "verified_outcome" });
    expect((await confirm(new Request("https://example.test/task", { method: "POST", body: JSON.stringify(confirmation) }), params)).status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "connector:write");
    expect(mocks.confirm).toHaveBeenCalledWith(principal, "task", confirmation);
  });

  it("rejects missing human evidence and unknown authority fields", async () => {
    for (const body of [{ ...confirmation, confirmedBy: "" }, { ...confirmation, confirmationRef: undefined }, { ...confirmation, projectId: "spoof" }]) {
      expect((await confirm(new Request("https://example.test/task", { method: "POST", body: JSON.stringify(body) }), params)).status).toBe(400);
    }
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("preserves ownership and transition rejections as 404/409", async () => {
    for (const status of [404, 409]) {
      mocks.confirm.mockRejectedValue(new ConnectorError("Scoped rejection", status));
      expect((await confirm(new Request("https://example.test/task", { method: "POST", body: JSON.stringify(confirmation) }), params)).status).toBe(status);
    }
  });

  it("task reads require a site and use connector:read", async () => {
    expect((await task(new Request("https://example.test/task"), params)).status).toBe(400);
    mocks.task.mockResolvedValue({ task: { id: "task" } });
    expect((await task(new Request("https://example.test/task?siteId=site"), params)).status).toBe(200);
    expect(mocks.task).toHaveBeenCalledWith(principal, "site", "task");
  });

  it("rejects an unversioned opportunity decision and malformed JSON", async () => {
    for (const body of ["{", JSON.stringify({ ...confirmation, operation: "accept" })]) {
      expect((await decide(new Request("https://example.test/op", { method: "POST", body }), { params: Promise.resolve({ opportunityId: "op" }) })).status).toBe(400);
    }
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});
