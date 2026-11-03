import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord, type MetricValue } from "@/lib/funnel/evidence";

/**
 * DS-04 (producer half): DataForSEO OnPage → typed evidence.
 *
 * The plan sequences DS-04 as: adapter → bounded dual-run with parity evidence →
 * switch read paths → migrate consumers. This module is the first step only. It
 * stores the raw payload and derives `onpage_crawl` / `internal_link_graph`
 * evidence; it does **not** touch the crawler, the audit tables or any read
 * path, because removing a producer before parity is proven would lose
 * capability the plan requires us to keep.
 *
 * Parity is a data question, so the adapter records everything needed to compare
 * against our own crawl: page identity, status, indexability, and the issues it
 * reports in our vocabulary.
 */

export type OnPageTaskResponse = {
  /** DataForSEO task id, for the raw payload join. */
  id: string;
  status: string;
  cost?: number;
  /** ISO timestamps as returned by the provider. */
  datetime?: string;
  result?: Array<{
    crawl_progress?: string;
    crawl_status?: { http_code?: number; pages_crawled?: number };
    items?: Array<{
      url?: string;
      status_code?: number;
      meta?: { title?: string; description?: string; canonical?: string; robots?: string };
      page_timing?: { duration_time?: number };
      checks?: Record<string, boolean | undefined>;
      content?: { plain_text_word_count?: number };
      onpage_score?: number;
      /** Present when the task was requested with links. */
      links?: Array<{ link_from?: string; link_to?: string; link_type?: string; is_internal?: boolean }>;
    }>;
  }>;
};

export type OnPageAdapterOptions = {
  projectId: string;
  siteId?: string | null;
  locale?: string | null;
  requestedAt: Date;
  deliveredAt?: Date;
  /** Provider-reported cost in micros; required for provenance. */
  costMicros: bigint;
};

/**
 * Provider check name → our issue vocabulary.
 *
 * Polarity is declared per check rather than assumed. DataForSEO names its
 * checks as problem indicators — `no_title: true` means there is no title,
 * `high_loading_time: true` means the page is slow — so the default is
 * "present". The field exists so the bounded dual-run can flip an individual
 * check if the live payload disagrees, without a code change elsewhere.
 */
export type OnPageCheck = {
  issueType: string;
  impact: "crawlability" | "structured_data" | "content";
  problemWhen: "absent" | "present";
};

export const ONPAGE_CHECK_MAP: Record<string, OnPageCheck> = {
  no_title: { issueType: "MISSING_TITLE", impact: "crawlability", problemWhen: "present" },
  title_too_long: { issueType: "TITLE_TOO_LONG", impact: "crawlability", problemWhen: "present" },
  no_description: { issueType: "MISSING_DESCRIPTION", impact: "crawlability", problemWhen: "present" },
  no_h1_tag: { issueType: "MISSING_H1", impact: "crawlability", problemWhen: "present" },
  // The provider reports canonical *presence*, not absence: `canonical: true` means
  // the tag exists. Verified against a live payload on 2026-11-03.
  canonical: { issueType: "MISSING_CANONICAL", impact: "crawlability", problemWhen: "absent" },
  no_image_alt: { issueType: "MISSING_ALT", impact: "crawlability", problemWhen: "present" },
  no_doctype: { issueType: "MISSING_DOCTYPE", impact: "crawlability", problemWhen: "present" },
  no_content_encoding: { issueType: "MISSING_ENCODING", impact: "crawlability", problemWhen: "present" },
  high_loading_time: { issueType: "SLOW_PAGE", impact: "crawlability", problemWhen: "present" },
  is_4xx_code: { issueType: "CLIENT_ERROR", impact: "crawlability", problemWhen: "present" },
  is_5xx_code: { issueType: "SERVER_ERROR", impact: "crawlability", problemWhen: "present" },
  is_redirect: { issueType: "REDIRECT", impact: "crawlability", problemWhen: "present" },
  // Deliberately unmapped: the provider has no "no schema at all" check. Its
  // `has_micromarkup` covers microdata only, so a JSON-LD site reports false and
  // mapping it to MISSING_SCHEMA would manufacture structured-data issues that
  // contradict our own crawler's JSON-LD detection. Verified on a live payload
  // (Wix/JSON-LD page, has_micromarkup: false) on 2026-11-03.
  // Deliberately unmapped: `low_content_rate` is a text-to-markup ratio, not thin
  // content. On a JS-heavy CMS every page trips it (30/30 on a real crawl,
  // including a 1,777-word article), so mapping it to THIN_CONTENT would flag the
  // whole site. Verified 2026-11-03.
};

export type OnPageAdapterResult = {
  rawResponseId: string;
  pages: number;
  issues: number;
  links: number;
  evidenceIds: string[];
  /** Checks the provider returned that we do not map yet: parity work, not silence. */
  unmappedChecks: string[];
};

export async function ingestOnPageResponse(
  db: Parameters<typeof storeEvidenceRecord>[0] & Pick<PrismaClient, "rawProviderResponse">,
  response: OnPageTaskResponse,
  options: OnPageAdapterOptions
): Promise<OnPageAdapterResult> {
  const deliveredAt = options.deliveredAt ?? new Date();
  const raw = await db.rawProviderResponse.create({
    data: {
      provider: "dataforseo",
      product: "onpage",
      // OnPage has no task_get: results are read from /on_page/pages.
      endpoint: "pages",
      providerTaskId: response.id,
      locale: options.locale ?? null,
      requestedAt: options.requestedAt,
      deliveredAt,
      costMicros: options.costMicros,
      status: response.status,
      payload: response as never,
    },
    select: { id: true },
  });

  const observedAt = response.datetime ? new Date(response.datetime) : deliveredAt;
  const observed = Number.isNaN(observedAt.getTime()) ? deliveredAt : observedAt;
  const evidenceIds: string[] = [];
  const unmapped = new Set<string>();
  let pages = 0;
  let issues = 0;
  let links = 0;

  for (const result of response.result ?? []) {
    for (const item of result.items ?? []) {
      if (!item.url) continue;
      pages += 1;
      const pageMetrics: Record<string, MetricValue> = {
        "provider:onpageScore": {
          value: typeof item.onpage_score === "number" ? item.onpage_score : null,
          unit: "score",
          source: "provider",
        },
      };
      if (typeof item.page_timing?.duration_time === "number") {
        pageMetrics["provider:loadMs"] = {
          value: Math.round(item.page_timing.duration_time * 1000),
          unit: "ms",
          source: "provider",
        };
      }

      await storeEvidenceRecord(db, {
        projectId: options.projectId,
        siteId: options.siteId ?? null,
        kind: "onpage_crawl",
        observedAt: observed,
        producer: "dataforseo",
        rawResponseId: raw.id,
        dimensions: {
          url: item.url,
          statusCode: item.status_code ?? null,
          title: item.meta?.title ?? null,
          canonical: item.meta?.canonical ?? null,
          wordCount: item.content?.plain_text_word_count ?? null,
          issueType: null,
          impact: null,
        },
        metrics: pageMetrics,
      });

      // Internal link graph: the shape the audit read paths use for link
      // evidence, so a dual-run can compare it before anything is switched.
      const internal = (item.links ?? []).filter((link) => link.is_internal !== false && link.link_to);
      if (internal.length > 0) {
        links += internal.length;
        await storeEvidenceRecord(db, {
          projectId: options.projectId,
          siteId: options.siteId ?? null,
          kind: "internal_link_graph",
          observedAt: observed,
          producer: "dataforseo",
          rawResponseId: raw.id,
          dimensions: {
            url: item.url,
            outboundInternal: internal.length,
            anchors: internal.slice(0, 20).map((link) => link.link_to).filter((url): url is string => Boolean(url)),
          },
          metrics: {
            "provider:internalLinks": { value: internal.length, unit: "count", source: "provider" },
          },
        });
      }

      for (const [check, value] of Object.entries(item.checks ?? {})) {
        if (typeof value !== "boolean") continue;
        const mapped = ONPAGE_CHECK_MAP[check];
        if (!mapped) {
          unmapped.add(check);
          continue;
        }
        const isProblem = mapped.problemWhen === "present" ? value === true : value === false;
        if (!isProblem) continue;
        issues += 1;
        const evidence = await storeEvidenceRecord(db, {
          projectId: options.projectId,
          siteId: options.siteId ?? null,
          kind: "onpage_crawl",
          observedAt: observed,
          producer: "dataforseo",
          rawResponseId: raw.id,
          dimensions: {
            url: item.url,
            statusCode: item.status_code ?? null,
            issueType: mapped.issueType,
            impact: mapped.impact,
            // Our own detectors key schema gaps off this pair.
            schemaMissing: mapped.impact === "structured_data" ? "true" : null,
            schemaType: mapped.impact === "structured_data" ? "LocalBusiness" : null,
            providerCheck: check,
          },
          metrics: {
            "provider:issueCount": { value: 1, unit: "count", source: "provider" },
          },
        });
        evidenceIds.push(evidence.id);
      }
    }
  }

  return {
    rawResponseId: raw.id,
    pages,
    issues,
    links,
    evidenceIds,
    unmappedChecks: [...unmapped].sort(),
  };
}

/**
 * DS-04 parity report: what a dual-run must prove before read paths move.
 * Counts are per issue type so a consumer switch cannot silently lose a check.
 */
export type ParityReport = {
  providerPages: number;
  ourPages: number;
  providerIssues: Record<string, number>;
  ourIssues: Record<string, number>;
  /** Issue types only the provider found. */
  providerOnly: string[];
  /** Issue types only our crawler found: these must survive any switch. */
  oursOnly: string[];
  /** Both found: candidates for replacement, after the dual-run confirms. */
  both: string[];
  parityProven: boolean;
};

export function compareCrawlParity(input: {
  providerIssues: Record<string, number>;
  ourIssues: Record<string, number>;
  providerPages: number;
  ourPages: number;
  /** Minimum page coverage for the run to count as evidence. */
  minPages?: number;
}): ParityReport {
  const minPages = input.minPages ?? 20;
  const keys = new Set([...Object.keys(input.providerIssues), ...Object.keys(input.ourIssues)]);
  const providerOnly: string[] = [];
  const oursOnly: string[] = [];
  const both: string[] = [];
  for (const key of keys) {
    const provider = input.providerIssues[key] ?? 0;
    const ours = input.ourIssues[key] ?? 0;
    if (provider > 0 && ours === 0) providerOnly.push(key);
    else if (ours > 0 && provider === 0) oursOnly.push(key);
    else if (provider > 0 && ours > 0) both.push(key);
  }
  return {
    providerPages: input.providerPages,
    ourPages: input.ourPages,
    providerIssues: input.providerIssues,
    ourIssues: input.ourIssues,
    providerOnly: providerOnly.sort(),
    oursOnly: oursOnly.sort(),
    both: both.sort(),
    // Parity is only proven when both sides saw enough pages and we lost nothing.
    parityProven:
      input.providerPages >= minPages &&
      input.ourPages >= minPages &&
      oursOnly.length === 0,
  };
}
