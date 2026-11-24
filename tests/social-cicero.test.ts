import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ciceroConfig, createCiceroClient } from "@/lib/social/cicero";
import { socialArtifact } from "@/lib/social/publish";

const COPY = { kicker: "TULUM", headline: "The lot is the decision.", subline: "", caption: "Buyer guidance." };

const ARTIFACT = socialArtifact({
  opportunityId: "opp_1",
  channel: "facebook_page",
  locale: "en",
  copy: COPY,
  asset: { path: "content/photo.jpg", alt: "" },
});

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

const headersOf = (fetchImpl: ReturnType<typeof vi.fn>) =>
  (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;

beforeEach(() => {
  process.env.CICERO_URL = "http://cicero.test/";
  process.env.INTERNAL_SERVICE_TOKEN = "one-secret";
});

afterEach(() => {
  delete process.env.CICERO_URL;
  delete process.env.INTERNAL_SERVICE_TOKEN;
});

describe("ciceroConfig", () => {
  it("needs both the url and the secret, and trims the trailing slash", () => {
    expect(ciceroConfig()).toEqual({ url: "http://cicero.test", token: "one-secret" });
    delete process.env.INTERNAL_SERVICE_TOKEN;
    expect(ciceroConfig()).toBeNull();
  });
});

describe("the render call", () => {
  it("sends the site it acts for, not a credential per tenant, and never a page id", async () => {
    const fetchImpl = respond(200, {
      render_id: "render_1",
      content_hash: "sha256:image",
      caption: COPY.caption,
      image: "social/renders/render_1/post.png",
      brand_revision: "sha256:brand",
      gate: { attempts: 2 },
    });
    await createCiceroClient({ siteId: "site_1", fetchImpl: fetchImpl as unknown as typeof fetch }).render({
      artifact: ARTIFACT,
      artDirection: "calm",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://cicero.test/v1/social/renders");
    const headers = headersOf(fetchImpl);
    expect(headers.authorization).toBe("Bearer one-secret");
    expect(headers["x-crawlseo-site-id"]).toBe("site_1");
    expect(JSON.stringify(headers).toLowerCase()).not.toContain("page");
    expect(JSON.stringify(JSON.parse(String(init.body)))).not.toContain("113590078393361");
  });

  it("returns what the receipt said", async () => {
    const fetchImpl = respond(200, {
      render_id: "render_1",
      content_hash: "sha256:image",
      caption: "caption from the render",
      image: "social/renders/render_1/post.png",
      brand_revision: "sha256:brand",
      gate: { attempts: 2 },
    });
    const result = await createCiceroClient({ siteId: "site_1", fetchImpl: fetchImpl as unknown as typeof fetch }).render({
      artifact: ARTIFACT,
      artDirection: "",
    });
    expect(result).toEqual({
      outcome: "rendered",
      renderId: "render_1",
      contentHash: "sha256:image",
      caption: "caption from the render",
      image: "social/renders/render_1/post.png",
      attempts: 2,
      brandRevision: "sha256:brand",
    });
  });

  it("turns a gate failure into its codes, not a generic error", async () => {
    const fetchImpl = respond(422, {
      detail: {
        code: "RENDER_GATE_FAILED",
        codes: ["OCCLUDED"],
        issues: [{ code: "OCCLUDED", severity: "error", detail: "type is covered" }],
      },
    });
    const result = await createCiceroClient({ siteId: "site_1", fetchImpl: fetchImpl as unknown as typeof fetch }).render({
      artifact: ARTIFACT,
      artDirection: "",
    });
    expect(result).toMatchObject({ outcome: "gate_failed", codes: ["OCCLUDED"] });
  });

  it("reports a missing brand as a refusal, not a retry", async () => {
    const fetchImpl = respond(404, { detail: "Brand not found" });
    const result = await createCiceroClient({ siteId: "site_1", fetchImpl: fetchImpl as unknown as typeof fetch }).render({
      artifact: ARTIFACT,
      artDirection: "",
    });
    expect(result).toMatchObject({ outcome: "refused", code: "CICERO_NOT_FOUND", retryable: false });
  });
});

describe("the publish call", () => {
  it("carries the caller's key and the render id", async () => {
    const fetchImpl = respond(200, {
      status: "published",
      provider_post_id: "113590078393361_1",
      draft: true,
    });
    const result = await createCiceroClient({ siteId: "site_1", fetchImpl: fetchImpl as unknown as typeof fetch }).publish({
      renderId: "render_1",
      idempotencyKey: "opp_1",
      draft: true,
    });
    expect(result).toEqual({
      outcome: "accepted",
      status: "published",
      providerPostId: "113590078393361_1",
      draft: true,
    });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ render_id: "render_1", idempotency_key: "opp_1", draft: true });
  });

  it("passes an unknown through as unknown", async () => {
    const fetchImpl = respond(200, { status: "unknown", provider_post_id: null, draft: true });
    const result = await createCiceroClient({ siteId: "site_1", fetchImpl: fetchImpl as unknown as typeof fetch }).publish({
      renderId: "render_1",
      idempotencyKey: "opp_1",
    });
    expect(result).toMatchObject({ outcome: "accepted", status: "unknown", providerPostId: null });
  });

  it("reads a 409 as no Page connected, which a retry cannot fix", async () => {
    const fetchImpl = respond(409, { detail: "No Facebook Page is connected for this brand" });
    const result = await createCiceroClient({ siteId: "site_1", fetchImpl: fetchImpl as unknown as typeof fetch }).publish({
      renderId: "render_1",
      idempotencyKey: "opp_1",
    });
    expect(result).toMatchObject({ outcome: "refused", code: "NO_PAGE_CONNECTED", retryable: false });
  });

  it("reads a 502 as retryable", async () => {
    const fetchImpl = respond(502, { detail: "Meta refused the post" });
    const result = await createCiceroClient({ siteId: "site_1", fetchImpl: fetchImpl as unknown as typeof fetch }).publish({
      renderId: "render_1",
      idempotencyKey: "opp_1",
    });
    expect(result).toMatchObject({ outcome: "refused", code: "CICERO_UNAVAILABLE", retryable: true });
  });

  it("does not mask a wrong secret as a retry", async () => {
    const fetchImpl = respond(401, { detail: "Invalid internal service token" });
    const result = await createCiceroClient({ siteId: "site_1", fetchImpl: fetchImpl as unknown as typeof fetch }).publish({
      renderId: "render_1",
      idempotencyKey: "opp_1",
    });
    expect(result).toMatchObject({ outcome: "refused", code: "CICERO_UNAUTHORIZED", retryable: false });
  });
});
