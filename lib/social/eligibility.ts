import type { OpportunityStatus } from "@prisma/client";
import { representedNames, type SiteRepresentation } from "@/lib/site/brand";

/**
 * The whole social eligibility rule.
 *
 * A post may exist only for an opportunity a human moved past `detected`. That
 * decision is already recorded — the dashboard sets `status` and `decidedBy` when
 * someone accepts, starts or ships an opportunity — so the rule reads it instead
 * of asking again.
 *
 * This replaced nine gates, a crawl lookup, claim extraction and a live re-check.
 * Those existed to police posts that assert things about the world. The pipeline
 * does not make them: it posts about work the brand acted on, and the human who
 * acted is the authority on whether the subject is real.
 *
 * What remains is mechanical: the copy has to exist, every specific in it has to
 * come from the brief, and the subject has to be something the brand may promote
 * when the profile says what that is.
 */

export type SocialCopy = {
  /** The subject the copy talks about, matched against the representation list. */
  subject?: string;
  kicker?: string;
  headline: string;
  subline?: string;
  caption?: string;
};

export type SocialDecisionInput = {
  opportunity: { id: string; status: OpportunityStatus; decidedBy: string | null };
  /** Opportunities that already have a post. One opportunity produces at most one. */
  postedOpportunityIds?: ReadonlySet<string>;
  copy?: SocialCopy | null;
  /** Specifics the brief marks `to_verify` (SOC-016). They must not reach copy. */
  toVerify?: readonly string[];
  /** The brand's representation (SOC-007). Omit to skip the subject check. */
  representation?: SiteRepresentation;
};

export type SocialRejection =
  | "NOT_ACTIONED"
  | "ALREADY_POSTED"
  | "COPY_UNSUPPORTED";

export type SocialDecision =
  | { outcome: "post"; opportunityId: string; subject: string }
  | { outcome: "reject"; reason: SocialRejection; detail: string };

/** The statuses a human can reach only by acting: "we are doing this". */
const ACTIONED: ReadonlySet<OpportunityStatus> = new Set<OpportunityStatus>(["accepted", "in_progress", "delivered"]);

function onImage(copy: SocialCopy): string[] {
  return [copy.kicker, copy.headline, copy.subline].filter((value): value is string => Boolean(value && value.trim()));
}

function matchesRepresentation(subject: string, names: readonly string[]): boolean {
  const needle = subject.trim().toLowerCase();
  if (!needle) return false;
  return names.some((name) => name === needle || name.includes(needle) || needle.includes(name));
}

export function decideSocialPost(input: SocialDecisionInput): SocialDecision {
  const { opportunity } = input;

  // `decidedBy` is part of the rule, not decoration: a row moved by a migration
  // or a detector is not a human decision, and posting on it would invent one.
  if (!ACTIONED.has(opportunity.status) || !opportunity.decidedBy) {
    return {
      outcome: "reject",
      reason: "NOT_ACTIONED",
      detail: `opportunity is ${opportunity.status}${opportunity.decidedBy ? "" : " without a human decision"}`,
    };
  }

  if (input.postedOpportunityIds?.has(opportunity.id)) {
    return { outcome: "reject", reason: "ALREADY_POSTED", detail: "this opportunity already has a post" };
  }

  const copy = input.copy;
  if (!copy || !copy.headline?.trim()) {
    return { outcome: "reject", reason: "COPY_UNSUPPORTED", detail: "the brief carries no copy to publish" };
  }

  const text = [copy.headline, copy.subline ?? "", copy.kicker ?? "", copy.caption ?? ""].join(" \u0000 ");
  for (const specific of input.toVerify ?? []) {
    const needle = specific.trim();
    if (needle && text.includes(needle)) {
      return {
        outcome: "reject",
        reason: "COPY_UNSUPPORTED",
        detail: `copy states a specific the brief has not verified: ${needle.slice(0, 80)}`,
      };
    }
  }

  if (input.representation) {
    const subject = (copy.subject ?? "").trim();
    const names = representedNames(input.representation);
    if (subject && !matchesRepresentation(subject, names)) {
      return {
        outcome: "reject",
        reason: "COPY_UNSUPPORTED",
        detail: `the brand does not represent ${subject.slice(0, 80)}`,
      };
    }
  }

  return { outcome: "post", opportunityId: opportunity.id, subject: (copy.subject ?? copy.headline).trim() };
}

/** The on-image strings of a post, in the order a renderer needs them. */
export function onImageCopy(copy: SocialCopy): string[] {
  return onImage(copy);
}
