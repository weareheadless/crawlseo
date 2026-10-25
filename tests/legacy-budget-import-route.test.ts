import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockImport = vi.hoisted(() => ({ import: vi.fn(), get: vi.fn(), freeze: vi.fn(), freezeGet: vi.fn() }));
vi.mock("@/lib/billing/legacy-budget-import", () => ({
  importLegacyBudget: mockImport.import,
  getLegacyBudgetImportReceipt: mockImport.get,
  freezeLegacyBudgetSourceDispatch: mockImport.freeze,
  getLegacyBudgetSourceFreezeReceipt: mockImport.freezeGet,
  LegacyBudgetImportError: class LegacyBudgetImportError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
  },
}));

import { GET, POST } from "@/app/api/internal/budget-imports/route";
import { POST as freezePost } from "@/app/api/internal/budget-imports/source-freeze/route";

const row = {
  localReservationId: "growth-budget-example",
  taskId: "run-example",
  operation: "dataforseo:article_keyword_overview",
  legacyStatus: "settled",
  period: "2026-10",
  timeZone: "UTC",
  currency: "USD",
  amountMicros: "100000",
  createdAt: "2026-10-06T14:05:15.000Z",
  updatedAt: "2026-10-06T14:05:17.000Z",
  settledAt: "2026-10-06T14:05:17.000Z",
};
const planBody = {
  mode: "plan",
  sourceProjectId: "old-project",
  sourceSiteId: "old-site",
  targetSiteId: "new-site",
  expectedBindingGeneration: 1,
  idempotencyKey: "history-import-2026-10",
  rows: [row],
};
function request(body: unknown, token = "provisioning-token") {
  return new Request("https://crawlseo.test/api/internal/budget-imports", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("internal legacy budget import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HELLOADA_PROVISIONING_TOKEN", "provisioning-token");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires the internal provisioning token before running a plan", async () => {
    const response = await POST(request(planBody, "wrong-token"));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockImport.import).not.toHaveBeenCalled();
  });

  it("accepts a protected dry-run mapping and returns no-store plan output", async () => {
    mockImport.import.mockResolvedValue({ mode: "plan", sourceEvidenceHash: "a".repeat(64), rows: [] });
    const response = await POST(request(planBody));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ mode: "plan", sourceEvidenceHash: "a".repeat(64) });
    expect(mockImport.import).toHaveBeenCalledWith(expect.objectContaining({
      sourceProjectId: "old-project", sourceSiteId: "old-site", targetSiteId: "new-site",
      expectedBindingGeneration: 1, rows: [expect.objectContaining({ localReservationId: "growth-budget-example" })],
    }));
  });

  it("refuses apply without the exact plan hash and rejects extra caller fields", async () => {
    const noHash = await POST(request({ ...planBody, mode: "apply" }));
    expect(noHash.status).toBe(400);
    expect(mockImport.import).not.toHaveBeenCalled();
    const extraField = await POST(request({ ...planBody, scopes: ["connector:write"] }));
    expect(extraField.status).toBe(400);
    expect(mockImport.import).not.toHaveBeenCalled();
  });

  it("protects readback and returns the persisted audit receipt without caching", async () => {
    mockImport.get.mockResolvedValue({ id: "receipt-1", snapshot: { rows: [] } });
    const unauthorized = await GET(new Request("https://crawlseo.test/api/internal/budget-imports?receiptId=receipt-1"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toBe("no-store");
    const response = await GET(new Request("https://crawlseo.test/api/internal/budget-imports?receiptId=receipt-1", {
      headers: { Authorization: "Bearer provisioning-token" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ id: "receipt-1", snapshot: { rows: [] } });
  });

  it("requires the reviewed source policy hash before applying the protected freeze", async () => {
    const plan = { mode: "freeze-source-plan", sourceProjectId: "old-project", sourceSiteId: "old-site",
      targetSiteId: "new-site", expectedBindingGeneration: 2, idempotencyKey: "freeze-v1", reason: "prevent duplicate research" };
    mockImport.freeze.mockResolvedValue({ mode: "freeze-source-plan", sourceDispatchHash: "b".repeat(64) });
    const planned = await freezePost(request(plan));
    expect(planned.status).toBe(200);
    expect(planned.headers.get("Cache-Control")).toBe("no-store");
    const missingHash = await freezePost(request({ ...plan, mode: "freeze-source-apply" }));
    expect(missingHash.status).toBe(400);
    expect(mockImport.freeze).toHaveBeenCalledTimes(1);
  });
});
