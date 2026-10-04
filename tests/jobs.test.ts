import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  job: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { claimNextJob, failJob, heartbeatJob } from "@/lib/jobs/queue";

describe("durable job queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.$executeRaw.mockResolvedValue(0);
    mockDb.$queryRaw.mockResolvedValue([]);
    mockDb.job.updateMany.mockResolvedValue({ count: 1 });
  });

  it("reclaims an available job with a worker lease", async () => {
    mockDb.$queryRaw.mockResolvedValue([{ id: "job-1" }]);
    mockDb.job.findUnique.mockResolvedValue({ id: "job-1", status: "RUNNING" });

    await expect(claimNextJob("worker-1", 120)).resolves.toEqual({
      id: "job-1",
      status: "RUNNING",
    });
    expect(mockDb.$executeRaw).toHaveBeenCalledTimes(2);
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("heartbeats only the job owned by the worker", async () => {
    await expect(heartbeatJob("job-1", "worker-1", 120)).resolves.toBe(true);
    expect(mockDb.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1", status: "RUNNING", leaseOwner: "worker-1" },
      })
    );
  });

  it("returns a pending retry before exhausting attempts", async () => {
    await failJob({ id: "job-1", attempts: 1, maxAttempts: 3 }, "worker-1", "GSC_SYNC_FAILED");

    expect(mockDb.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1", status: "RUNNING", leaseOwner: "worker-1" },
        data: expect.objectContaining({
          status: "PENDING",
          lastErrorCode: "GSC_SYNC_FAILED",
          leaseOwner: null,
          leaseExpiresAt: null,
        }),
      })
    );
  });
});
