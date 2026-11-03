import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/internal/sites/[siteId]/technical-actions/reassess/route";

const priorToken = process.env.HELLOADA_PROVISIONING_TOKEN;

afterEach(() => {
  if (priorToken === undefined) delete process.env.HELLOADA_PROVISIONING_TOKEN;
  else process.env.HELLOADA_PROVISIONING_TOKEN = priorToken;
});

const request = (token?: string) =>
  new Request("http://localhost/api/internal/sites/s1/technical-actions/reassess", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({}),
  });

describe("technical reassess endpoint is retired (wave 6)", () => {
  it("still authenticates, so an unauthenticated request cannot probe it", async () => {
    process.env.HELLOADA_PROVISIONING_TOKEN = "secret";
    const response = await POST(request());
    expect(response.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    process.env.HELLOADA_PROVISIONING_TOKEN = "secret";
    const response = await POST(request("wrong"));
    expect(response.status).toBe(401);
  });

  it("answers 410 to an authorised caller and says what replaced it", async () => {
    process.env.HELLOADA_PROVISIONING_TOKEN = "secret";
    const response = await POST(request("secret"));
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: string; detail: string; replacedBy: string };
    expect(body.error).toMatch(/retired/i);
    expect(body.detail).toMatch(/O7\/O8 detectors/);
    expect(body.replacedBy).toContain("crawl");
  });

  it("does not create or revise any legacy row", async () => {
    process.env.HELLOADA_PROVISIONING_TOKEN = "secret";
    const response = await POST(request("secret"));
    // A retired endpoint returns before touching the database at all.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("actionId");
  });
});
