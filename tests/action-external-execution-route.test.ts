import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  updateResearchAction: vi.fn(),
  generateDraftForAction: vi.fn(),
  createAgentTaskForAction: vi.fn(),
  createAgentTaskIfEligible: vi.fn(),
  generateWixBlogUpdateDraftForAction: vi.fn(),
}));

vi.mock("@/lib/session-helper", () => ({ getUserIdFromCookies: vi.fn().mockResolvedValue("user-1") }));
vi.mock("@/lib/auth/research-action-access", () => ({ researchActionAccess: mocks.access }));
vi.mock("@/lib/research/service", () => ({
  ResearchServiceError: class ResearchServiceError extends Error {},
  updateResearchAction: mocks.updateResearchAction,
}));
vi.mock("@/lib/research/content", () => ({
  generateDraftForAction: mocks.generateDraftForAction,
  generateWixBlogUpdateDraftForAction: mocks.generateWixBlogUpdateDraftForAction,
}));
vi.mock("@/lib/agent-tasks/service", () => ({
  createAgentTaskForAction: mocks.createAgentTaskForAction,
  createAgentTaskIfEligible: mocks.createAgentTaskIfEligible,
}));

import { PATCH } from "@/app/api/actions/[actionId]/route";
import { POST as draftAction } from "@/app/api/actions/[actionId]/draft/route";
import { POST as agentTaskAction } from "@/app/api/actions/[actionId]/agent-task/route";
import { POST as wixBlogDraftAction } from "@/app/api/actions/[actionId]/wix-blog-draft/route";

const params = { params: Promise.resolve({ actionId: "action-1" }) };
const request = () => new Request("http://localhost/api/actions/action-1", { method: "POST", body: "{}" });

describe("cookie Action routes on externally managed sites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue("external");
  });

  it("refuses local status mutations with a managed-elsewhere conflict", async () => {
    const response = await PATCH(request(), params);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("managed in HelloAda") });
    expect(mocks.updateResearchAction).not.toHaveBeenCalled();
  });

  it("refuses local draft generation", async () => {
    const response = await draftAction(request(), params);
    expect(response.status).toBe(409);
    expect(mocks.generateDraftForAction).not.toHaveBeenCalled();
  });

  it("refuses local agent-task creation and Wix Blog updates", async () => {
    expect((await agentTaskAction(request(), params)).status).toBe(409);
    expect((await wixBlogDraftAction(request(), params)).status).toBe(409);
    expect(mocks.createAgentTaskForAction).not.toHaveBeenCalled();
    expect(mocks.generateWixBlogUpdateDraftForAction).not.toHaveBeenCalled();
  });

  it("keeps returning 404 for an Action the user does not own", async () => {
    mocks.access.mockResolvedValue("missing");
    expect((await PATCH(request(), params)).status).toBe(404);
    expect(mocks.updateResearchAction).not.toHaveBeenCalled();
  });
});
