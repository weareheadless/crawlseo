import Link from "next/link";

import { db } from "@/lib/db";
import { taxonomyReviewState } from "@/lib/research/taxonomy-review";
import { TaxonomyReviewButton } from "@/components/research/taxonomy-review-button";

/**
 * The one visible trace of an automatic taxonomy approval.
 *
 * The model proposes the job map, the taxonomy is its projection, and it is used
 * immediately to decide which queries get paid measurement. A person should still
 * read it: this notice says so, links to the map, and records the check. A new
 * taxonomy brings the notice back.
 */
export async function TaxonomyReviewNotice({ siteId, showMapLink = true }: { siteId: string; showMapLink?: boolean }) {
  const state = await taxonomyReviewState(db, siteId);
  // Only an automatic approval asks for a human look. A taxonomy a person
  // approved through the CLI is already reviewed by that person.
  if (!state.needsReview || !state.autoApproved || !state.taxonomy) return null;

  const topics = state.taxonomy.topics.length;
  const approvedOn = state.taxonomy.generatedAt.slice(0, 10);
  return (
    <section
      className="mb-6 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3"
      aria-labelledby="taxonomy-review"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="taxonomy-review" className="font-heading text-sm font-semibold text-foreground">
            Topic taxonomy approved automatically
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {topics} topic{topics === 1 ? "" : "s"} from the site&apos;s pages and research, approved on {approvedOn}. It is
            already deciding which queries are measured. Review it and mark it read; a new taxonomy opens a new notice.
          </p>
          {showMapLink && (
            <Link href={`/sites/${siteId}/demand`} className="mt-1 inline-block text-xs text-primary hover:underline">
              Open the demand map →
            </Link>
          )}
        </div>
        <TaxonomyReviewButton siteId={siteId} />
      </div>
    </section>
  );
}
