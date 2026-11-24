/**
 * One actioned opportunity becomes one post, once.
 *
 * The rule is not re-implemented here: `decideSocialPost` answers whether this
 * opportunity may produce a post at all, and this module does the arithmetic —
 * render, publish, record what Cicero said.
 *
 * There is no queue, no state machine and no retry loop. A receipt row is the
 * idempotency record: a second call with the same opportunity reads it instead of
 * posting again, and a row is only written once something actually landed. The
 * one exception is `unknown`, where a write may have reached Meta — that is
 * recorded and refused forever, because a maybe is never re-posted.
 */

import { createHash } from "node:crypto";
import type { OpportunityStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { decideSocialPost, type SocialCopy, type SocialRejection } from "@/lib/social/eligibility";
import {
  ciceroEnabled,
  createCiceroClient,
  type CiceroClient,
  type SocialArtifactPayload,
} from "@/lib/social/cicero";
import { readSiteBrand, type SiteRepresentation } from "@/lib/site/brand";

export type SocialChannel = "facebook_page";
export type SocialStatus = "published" | "draft" | "unknown";

export type SocialReceipt = {
  opportunityId: string;
  projectId: string;
  channel: SocialChannel;
  locale: string;
  status: SocialStatus;
  renderId: string | null;
  providerPostId: string | null;
  caption: string;
  contentHash: string;
  gateAttempts: number | null;
  error: string;
  decidedAt: Date | null;
  /** Null for `unknown`: nothing is known about when, or whether, it landed. */
  publishedAt: Date | null;
};

export type SocialOpportunity = {
  id: string;
  projectId: string;
  status: OpportunityStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
};

export type SocialAsset = { path: string; alt?: string };

export type PublishResult =
  | { outcome: "posted"; receipt: SocialReceipt; replay: boolean }
  | {
      outcome: "rejected";
      reason: SocialRejection | "RENDER_GATE_FAILED";
      detail: string;
      /** Cicero's gate codes, when the render was refused for a visual reason. */
      codes?: string[];
    }
  | { outcome: "refused"; code: string; detail: string; retryable: boolean };

export type PublishInput = {
  opportunity: SocialOpportunity;
  copy: SocialCopy | null;
  asset: SocialAsset;
  locale?: string;
  channel?: SocialChannel;
  draft?: boolean;
  artDirection?: string;
  /** The receipt this opportunity already has, if any. */
  existing?: SocialReceipt | null;
  representation?: SiteRepresentation;
  cicero: CiceroClient;
  record?: (receipt: SocialReceipt) => Promise<void>;
};

/** JSON with sorted keys, so the same artifact always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function socialArtifact(input: {
  opportunityId: string;
  channel: SocialChannel;
  locale: string;
  copy: SocialCopy;
  asset: SocialAsset;
}): SocialArtifactPayload {
  const body = {
    channel: input.channel,
    locale: input.locale,
    copy: {
      kicker: input.copy.kicker ?? "",
      headline: input.copy.headline,
      subline: input.copy.subline ?? "",
      caption: input.copy.caption ?? "",
    },
    asset: { path: input.asset.path, alt: input.asset.alt ?? "" },
  };
  const contentHash = `sha256:${createHash("sha256").update(canonical(body)).digest("hex")}`;
  return {
    id: `art_${input.opportunityId}_${input.locale}`,
    ...body,
    content_hash: contentHash,
  };
}

export async function publishSocialPost(input: PublishInput): Promise<PublishResult> {
  const channel = input.channel ?? "facebook_page";
  const locale = input.locale ?? "en";

  // A receipt means the question was already answered. Replay it, including an
  // `unknown`: nothing there may be posted a second time.
  if (input.existing) {
    return { outcome: "posted", receipt: input.existing, replay: true };
  }

  const decision = decideSocialPost({
    opportunity: input.opportunity,
    copy: input.copy,
    representation: input.representation,
  });
  if (decision.outcome === "reject") {
    return { outcome: "rejected", reason: decision.reason, detail: decision.detail };
  }

  const artifact = socialArtifact({
    opportunityId: input.opportunity.id,
    channel,
    locale,
    copy: input.copy as SocialCopy,
    asset: input.asset,
  });

  const rendered = await input.cicero.render({ artifact, artDirection: input.artDirection ?? "" });
  if (rendered.outcome === "gate_failed") {
    // Nothing is recorded: the model is stochastic, so a retry may pass, and a
    // cached failure would block the only recovery path there is.
    return {
      outcome: "rejected",
      reason: "RENDER_GATE_FAILED",
      detail: `the render gate refused it (${rendered.codes.join(", ") || "no code"})`,
      codes: rendered.codes,
    };
  }
  if (rendered.outcome === "refused") {
    return rendered;
  }

  const published = await input.cicero.publish({
    renderId: rendered.renderId,
    // The opportunity is the idempotency key: one decision, one post.
    idempotencyKey: input.opportunity.id,
    draft: input.draft,
    caption: rendered.caption,
  });
  if (published.outcome === "refused") {
    return published;
  }

  const receipt: SocialReceipt = {
    opportunityId: input.opportunity.id,
    projectId: input.opportunity.projectId,
    channel,
    locale,
    status: published.status,
    renderId: rendered.renderId,
    providerPostId: published.providerPostId,
    caption: rendered.caption,
    contentHash: rendered.contentHash,
    gateAttempts: rendered.attempts,
    error: published.status === "unknown" ? "Meta's response was not received; it may have landed" : "",
    decidedAt: input.opportunity.decidedAt ?? null,
    publishedAt: published.status === "unknown" ? null : new Date(),
  };
  await input.record?.(receipt);
  return { outcome: "posted", receipt, replay: false };
}

const RECEIPT_SELECT = {
  opportunityId: true,
  projectId: true,
  channel: true,
  locale: true,
  status: true,
  renderId: true,
  providerPostId: true,
  caption: true,
  contentHash: true,
  gateAttempts: true,
  error: true,
  decidedAt: true,
  publishedAt: true,
} as const;

function asReceipt(row: {
  [K in keyof typeof RECEIPT_SELECT]: unknown;
}): SocialReceipt {
  const value = row as Record<string, unknown>;
  return {
    opportunityId: String(value.opportunityId),
    projectId: String(value.projectId),
    channel: String(value.channel) as SocialChannel,
    locale: String(value.locale),
    status: String(value.status) as SocialStatus,
    renderId: (value.renderId as string | null) ?? null,
    providerPostId: (value.providerPostId as string | null) ?? null,
    caption: String(value.caption ?? ""),
    contentHash: String(value.contentHash ?? ""),
    gateAttempts: (value.gateAttempts as number | null) ?? null,
    error: String(value.error ?? ""),
    decidedAt: (value.decidedAt as Date | null) ?? null,
    publishedAt: (value.publishedAt as Date | null) ?? null,
  };
}

export type PublishOpportunityInput = {
  opportunityId: string;
  /** The CrawlSEO site whose brand renders this; Cicero resolves the brand from it. */
  siteId: string;
  copy: SocialCopy | null;
  asset: SocialAsset;
  locale?: string;
  channel?: SocialChannel;
  draft?: boolean;
  artDirection?: string;
  client?: CiceroClient;
};

/**
 * The wired version: load the opportunity, its receipt and the brand, then post.
 *
 * The copy and the image arrive from the caller — writing them is the brief's
 * job, not the publisher's — and everything else is read here so a caller cannot
 * hand in an opportunity that was never actioned.
 */
export async function publishOpportunity(input: PublishOpportunityInput): Promise<PublishResult> {
  if (!input.client && !ciceroEnabled()) {
    // No renderer, no post. Refused rather than thrown, so a caller records a
    // reason instead of a crash, and nothing here grows a second publisher.
    return {
      outcome: "refused",
      code: "CICERO_NOT_CONFIGURED",
      detail: "CICERO_URL and INTERNAL_SERVICE_TOKEN are not set",
      retryable: false,
    };
  }

  const opportunity = await db.opportunity.findUnique({
    where: { id: input.opportunityId },
    select: { id: true, projectId: true, status: true, decidedBy: true, decidedAt: true },
  });
  if (!opportunity) throw new Error(`Opportunity ${input.opportunityId} does not exist`);

  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { projectId: true },
  });
  if (!site || site.projectId !== opportunity.projectId) {
    throw new Error("The site does not belong to the opportunity's project");
  }

  const existing = await db.socialPost.findUnique({
    where: { opportunityId: opportunity.id },
    select: RECEIPT_SELECT,
  });
  const profile = await readSiteBrand(db, input.siteId);

  return publishSocialPost({
    opportunity,
    copy: input.copy,
    asset: input.asset,
    locale: input.locale,
    channel: input.channel,
    draft: input.draft,
    artDirection: input.artDirection,
    existing: existing ? asReceipt(existing) : null,
    representation: profile?.representation,
    cicero: input.client ?? createCiceroClient({ siteId: input.siteId }),
    record: async (receipt) => {
      try {
        await db.socialPost.create({ data: receipt });
      } catch (error) {
        // Two callers racing on one opportunity: the unique index decides, and
        // the loser reads the winner's receipt on its next attempt.
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
    },
  });
}
