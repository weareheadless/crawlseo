import { describe, expect, it, vi } from "vitest";
import type { OpportunityStatus } from "@prisma/client";
import { publishSocialPost, socialArtifact, type SocialReceipt } from "@/lib/social/publish";
import type { CiceroClient } from "@/lib/social/cicero";
import type { SocialCopy } from "@/lib/social/eligibility";
import { parseSiteRepresentation } from "@/lib/site/brand";

const COPY: SocialCopy = {
  subject: "Playa del Carmen",
  kicker: "PLAYA DEL CARMEN",
  headline: "Two streets back from the sand.",
  subline: "What $700,000 buys, and what it does not.",
  caption: "Buyer guidance for Playa del Carmen.",
};

const REPRESENTATION = parseSiteRepresentation({
  serviceArea: { countries: ["MX"], regions: [], places: ["Playa del Carmen"] },
  entries: [],
});

function opportunity(status: OpportunityStatus = "delivered", decidedBy: string | null = "susi@example.com") {
  return {
    id: "opp_1",
    projectId: "proj_1",
    status,
    decidedBy,
    decidedAt: new Date("2026-11-24T09:00:00Z"),
  };
}

function fakeCicero(overrides: Partial<CiceroClient> = {}) {
  const calls = { render: 0, publish: 0, publishInput: [] as Array<Record<string, unknown>> };
  const client: CiceroClient = {
    async render(input) {
      calls.render += 1;
      if (overrides.render) return overrides.render(input);
      return {
        outcome: "rendered",
        renderId: "render_1",
        contentHash: "sha256:image",
        caption: COPY.caption ?? "",
        image: "social/renders/render_1/post.png",
        brandRevision: "sha256:brand",
      };
    },
    async publish(input) {
      calls.publish += 1;
      calls.publishInput.push(input as unknown as Record<string, unknown>);
      if (overrides.publish) return overrides.publish(input);
      return { outcome: "accepted", status: "published", providerPostId: "page_1_post_1", draft: false };
    },
  };
  return { client, calls };
}

const base = (overrides: Partial<Parameters<typeof publishSocialPost>[0]> = {}) => ({
  opportunity: opportunity(),
  copy: COPY,
  asset: { path: "content/susi-photo-6.jpg", alt: "Courtyard pool at dusk" },
  representation: REPRESENTATION,
  cicero: fakeCicero().client,
  ...overrides,
});

describe("publishSocialPost", () => {
  it("publishes an actioned opportunity once and records the receipt", async () => {
    const { client, calls } = fakeCicero();
    const recorded: SocialReceipt[] = [];
    const result = await publishSocialPost(
      base({ cicero: client, record: async (receipt) => void recorded.push(receipt) }),
    );

    expect(result.outcome).toBe("posted");
    if (result.outcome !== "posted") return;
    expect(result.receipt.status).toBe("published");
    expect(result.receipt.providerPostId).toBe("page_1_post_1");
    expect(result.receipt.renderId).toBe("render_1");
    expect(result.receipt.decidedAt).toEqual(new Date("2026-11-24T09:00:00Z"));
    expect(recorded).toHaveLength(1);
    expect(calls.render).toBe(1);
    expect(calls.publish).toBe(1);
  });

  it("uses the opportunity id as the idempotency key", async () => {
    const { client, calls } = fakeCicero();
    await publishSocialPost(base({ cicero: client }));
    expect(calls.publishInput[0].idempotencyKey).toBe("opp_1");
  });

  it("publishes nothing for an opportunity nobody actioned", async () => {
    for (const status of ["detected", "parked", "rejected"] as OpportunityStatus[]) {
      const { client, calls } = fakeCicero();
      const record = vi.fn();
      const result = await publishSocialPost(
        base({ opportunity: opportunity(status), cicero: client, record }),
      );
      expect(result).toMatchObject({ outcome: "rejected", reason: "NOT_ACTIONED" });
      expect(calls.render).toBe(0);
      expect(calls.publish).toBe(0);
      expect(record).not.toHaveBeenCalled();
    }
  });

  it("does not treat a row moved without a human as actioned", async () => {
    const { client, calls } = fakeCicero();
    const result = await publishSocialPost(
      base({ opportunity: opportunity("delivered", null), cicero: client }),
    );
    expect(result).toMatchObject({ outcome: "rejected", reason: "NOT_ACTIONED" });
    expect(calls.publish).toBe(0);
  });

  it("replays the receipt instead of posting a second time", async () => {
    const existing: SocialReceipt = {
      opportunityId: "opp_1",
      projectId: "proj_1",
      channel: "facebook_page",
      locale: "en",
      status: "published",
      renderId: "render_1",
      providerPostId: "page_1_post_1",
      caption: COPY.caption ?? "",
      contentHash: "sha256:image",
      error: "",
      decidedAt: new Date("2026-11-24T09:00:00Z"),
      publishedAt: new Date("2026-11-24T10:00:00Z"),
    };
    const { client, calls } = fakeCicero();
    const result = await publishSocialPost(base({ existing, cicero: client }));

    expect(result).toMatchObject({ outcome: "posted", replay: true });
    if (result.outcome !== "posted") return;
    expect(result.receipt).toBe(existing);
    expect(calls.render).toBe(0);
    expect(calls.publish).toBe(0);
  });

  it("records an unknown outcome and never posts it again", async () => {
    const { client, calls } = fakeCicero({
      async publish() {
        return { outcome: "accepted", status: "unknown", providerPostId: null, draft: true };
      },
    });
    const recorded: SocialReceipt[] = [];
    const first = await publishSocialPost(
      base({ cicero: client, record: async (receipt) => void recorded.push(receipt) }),
    );
    expect(first.outcome).toBe("posted");
    if (first.outcome !== "posted") return;
    expect(first.receipt.status).toBe("unknown");
    expect(first.receipt.publishedAt).toBeNull();
    expect(recorded).toHaveLength(1);

    const second = await publishSocialPost(
      base({ existing: first.receipt, cicero: client, record: async (receipt) => void recorded.push(receipt) }),
    );
    expect(second).toMatchObject({ outcome: "posted", replay: true });
    expect(calls.publish).toBe(1);
    expect(recorded).toHaveLength(1);
  });

  it("records nothing when Cicero refuses, so a retry may try again", async () => {
    const { client, calls } = fakeCicero({
      async publish() {
        return { outcome: "refused", code: "CICERO_UNAVAILABLE", detail: "Meta refused the post", retryable: true };
      },
    });
    const record = vi.fn();
    const first = await publishSocialPost(base({ cicero: client, record }));
    expect(first).toMatchObject({ outcome: "refused", code: "CICERO_UNAVAILABLE" });
    expect(record).not.toHaveBeenCalled();

    await publishSocialPost(base({ cicero: client, record }));
    expect(calls.publish).toBe(2);
  });

  it("does not render a brief with no copy", async () => {
    const { client, calls } = fakeCicero();
    const result = await publishSocialPost(base({ copy: null, cicero: client }));
    expect(result).toMatchObject({ outcome: "rejected", reason: "COPY_UNSUPPORTED" });
    expect(calls.render).toBe(0);
  });

  it("refuses a subject the brand does not represent", async () => {
    const { client, calls } = fakeCicero();
    const result = await publishSocialPost(
      base({ copy: { ...COPY, subject: "Tulum" }, cicero: client }),
    );
    expect(result).toMatchObject({ outcome: "rejected", reason: "COPY_UNSUPPORTED" });
    expect(calls.render).toBe(0);
  });

  it("leaves the gate report's attempts on the receipt", async () => {
    const { client } = fakeCicero();
    const result = await publishSocialPost(base({ cicero: client }));
    if (result.outcome !== "posted") throw new Error("expected a post");
    expect(result.receipt.contentHash).toBe("sha256:image");
    expect(result.receipt.channel).toBe("facebook_page");
    expect(result.receipt.locale).toBe("en");
  });
});

describe("socialArtifact", () => {
  it("is content-addressed: same copy, same hash", () => {
    const one = socialArtifact({ opportunityId: "opp_1", channel: "facebook_page", locale: "en", copy: COPY, asset: { path: "a.jpg" } });
    const two = socialArtifact({ opportunityId: "opp_1", channel: "facebook_page", locale: "en", copy: COPY, asset: { path: "a.jpg" } });
    expect(one.content_hash).toBe(two.content_hash);
  });

  it("changes when a word changes, and when the locale does", () => {
    const one = socialArtifact({ opportunityId: "opp_1", channel: "facebook_page", locale: "en", copy: COPY, asset: { path: "a.jpg" } });
    const edited = socialArtifact({
      opportunityId: "opp_1",
      channel: "facebook_page",
      locale: "en",
      copy: { ...COPY, headline: "A different line." },
      asset: { path: "a.jpg" },
    });
    const spanish = socialArtifact({ opportunityId: "opp_1", channel: "facebook_page", locale: "es", copy: COPY, asset: { path: "a.jpg" } });
    expect(edited.content_hash).not.toBe(one.content_hash);
    expect(spanish.content_hash).not.toBe(one.content_hash);
  });

  it("names the artifact after the opportunity and locale", () => {
    const artifact = socialArtifact({ opportunityId: "opp_1", channel: "facebook_page", locale: "es", copy: COPY, asset: { path: "a.jpg" } });
    expect(artifact.id).toBe("art_opp_1_es");
    expect(artifact.copy.headline).toBe(COPY.headline);
    expect(artifact.asset).toEqual({ path: "a.jpg", alt: "" });
  });
});
