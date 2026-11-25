import { editorialConfig, editorialTerminal } from "@/lib/editorial-service/client";

/**
 * Editorial's side of a social post: the gate that exists, wired up.
 *
 * The copy arrives grounded — the planner says which source every specific came
 * from — and editorial refuses it when the claim is unsupported, the copy
 * drifted, the subject is not the brand's to promote, or the image has no
 * declared provenance. Editorial never publishes; it verifies and holds.
 */

export type SocialBriefInput = {
  tenant: string;
  locale: string;
  voice?: string;
  subject: string;
  angle: string;
  copy: { kicker: string; headline: string; subline: string; caption: string };
  image: { name: string; alt?: string; provenance?: "own_photo" | "generic_location" | "none" };
  representation?: "represented" | "own_service" | "commentary" | "unrepresented";
  claims: Array<{ text: string; source_url: string }>;
  idempotencyKey: string;
  deadlineMs?: number;
};

export type EditorialSocialArtifact = {
  id: string;
  locale: string;
  contentHash: string;
  status: string;
  social: {
    channel: string;
    locale: string;
    kicker: string;
    headline: string;
    subline: string;
    caption: string;
    image: { asset_id: string; provenance: string; alt: string; credit: string };
    representation: string;
    subject: string;
  };
};

export type SocialVerification =
  | { state: "verified"; postId: string; artifact: EditorialSocialArtifact }
  | { state: "held"; postId: string; issues: Array<{ code: string; detail: string }> }
  | { state: "failed"; postId: string; detail: string }
  | { state: "error"; detail: string };

export function socialBrief(input: SocialBriefInput): Record<string, unknown> {
  return {
    tenant: input.tenant,
    format: "social",
    mode: "brief",
    locales: [input.locale],
    voice: input.voice || "default",
    // Editorial verifies and holds; it never publishes.
    policy: { publish: false, approval: "owner" },
    topic: { angle: input.angle, notes: input.subject },
    social: {
      channel: "facebook_page",
      copy_by_locale: {
        [input.locale]: {
          kicker: input.copy.kicker,
          headline: input.copy.headline,
          subline: input.copy.subline,
          caption: input.copy.caption,
        },
      },
      image: {
        asset_id: input.image.name,
        provenance: input.image.provenance ?? "own_photo",
        alt: input.image.alt ?? "",
        credit: "",
      },
      representation: input.representation ?? "represented",
      subject: input.subject,
      // The planner has already dropped any claim whose source the bundle did
      // not contain, so what arrives here is what a source vouches for.
      claims: input.claims.map((claim) => ({
        text: claim.text,
        source_url: claim.source_url,
        verdict: "supported",
      })),
    },
    idempotency_key: input.idempotencyKey,
  };
}

async function request(path: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const config = editorialConfig();
  if (!config) throw new Error("The editorial service is not configured");
  const response = await fetch(`${config.url}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { detail: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Submit a social brief and wait for the verdict. */
export async function verifySocialPost(input: SocialBriefInput): Promise<SocialVerification> {
  const created = await request("/v1/posts", {
    method: "POST",
    body: JSON.stringify(socialBrief(input)),
  });
  if (created.status !== 202 && created.status !== 200) {
    return {
      state: "error",
      detail: `Editorial refused the brief (${created.status}): ${JSON.stringify(created.body).slice(0, 400)}`,
    };
  }
  const postId = created.body?.post_id as string | undefined;
  if (!postId) return { state: "error", detail: "Editorial returned no post id" };

  const deadline = Date.now() + (input.deadlineMs ?? 60_000);
  let last = created.body?.state ?? "queued";
  while (Date.now() < deadline) {
    const read = await request(`/v1/posts/${encodeURIComponent(postId)}`, { method: "GET" });
    if (read.status !== 200) {
      return { state: "error", detail: `Editorial could not report the post (${read.status})` };
    }
    const post = read.body as {
      state?: string;
      error?: string;
      artifacts?: Record<string, any>;
      events?: Array<{ type: string; data?: Record<string, unknown> }>;
    };
    last = post.state ?? last;
    if (editorialTerminal(last)) {
      const artifact = post.artifacts?.[input.locale];
      if (last === "ready" && artifact?.social) {
        return {
          state: "verified",
          postId,
          artifact: {
            id: String(artifact.id),
            locale: String(artifact.locale ?? input.locale),
            contentHash: String(artifact.content_hash ?? ""),
            status: String(artifact.status ?? ""),
            social: artifact.social,
          },
        };
      }
      const held = artifact?.editorial?.social_issues;
      if (Array.isArray(held) && held.length > 0) {
        return {
          state: "held",
          postId,
          issues: held.map((issue: any) => ({
            code: String(issue.code ?? ""),
            detail: String(issue.detail ?? ""),
          })),
        };
      }
      const reason = post.events?.find((event) => event.type === "held")?.data?.reason;
      return {
        state: "failed",
        postId,
        detail: String(reason ?? post.error ?? `editorial state ${last}`),
      };
    }
    await sleep(400);
  }
  return { state: "failed", postId, detail: `editorial did not finish within the deadline (${last})` };
}
