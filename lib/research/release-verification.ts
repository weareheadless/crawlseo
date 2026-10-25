import { liveCheckFromHtml } from "@/lib/research/crawl-live-check";

const SUPPORTED = new Set([
  "MISSING_H1",
  "MULTIPLE_H1",
  "MISSING_TITLE",
  "MISSING_DESCRIPTION",
  "MISSING_CANONICAL",
  "MISSING_SCHEMA",
  "MISSING_ALT",
]);
const LIVE_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

type OutcomeEvidence = {
  issue_type?: unknown;
  batch?: unknown;
  urls?: unknown;
};

export type ReleaseOutcome = {
  supported: boolean;
  verified: boolean | null;
  issueType: string;
  checkedUrls: string[];
  failedUrls: string[];
  reason: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function verifyReleaseOutcome(input: {
  targetUrl: string | null;
  evidence: unknown;
  fetchImpl?: typeof fetch;
}): Promise<ReleaseOutcome> {
  const evidence = record(input.evidence) as OutcomeEvidence;
  const issueType = typeof evidence.issue_type === "string" ? evidence.issue_type : "";
  if (!SUPPORTED.has(issueType)) {
    return { supported: false, verified: null, issueType, checkedUrls: [], failedUrls: [], reason: "unsupported issue type" };
  }
  const urls = [
    input.targetUrl,
    ...(Array.isArray(evidence.urls)
      ? evidence.urls.filter((url): url is string => typeof url === "string")
      : []),
  ].filter((url): url is string => Boolean(url));
  const unique = [...new Set(urls)].slice(0, evidence.batch === true ? 6 : 1);
  const checkedUrls: string[] = [];
  const failedUrls: string[] = [];
  let unavailable = 0;
  for (const url of unique) {
    try {
      const response = await (input.fetchImpl ?? fetch)(url, {
        redirect: "follow",
        headers: {
          "User-Agent": LIVE_UA,
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        unavailable += 1;
        continue;
      }
      checkedUrls.push(url);
      const check = liveCheckFromHtml(issueType, await response.text());
      if (check.issue_reproduced === true) failedUrls.push(url);
      if (check.issue_reproduced === null) unavailable += 1;
    } catch {
      unavailable += 1;
    }
  }
  if (failedUrls.length > 0) {
    return {
      supported: true,
      verified: false,
      issueType,
      checkedUrls,
      failedUrls,
      reason: `Issue still reproduces on ${failedUrls.length} of ${checkedUrls.length} checked page(s).`,
    };
  }
  if (checkedUrls.length === 0) {
    return {
      supported: true,
      verified: null,
      issueType,
      checkedUrls,
      failedUrls,
      reason: "No target page could be checked after publication.",
    };
  }
  if (unavailable > 0) {
    return {
      supported: true,
      verified: null,
      issueType,
      checkedUrls,
      failedUrls,
      reason: `Issue did not reproduce on checked pages, but ${unavailable} page(s) could not be checked.`,
    };
  }
  return {
    supported: true,
    verified: true,
    issueType,
    checkedUrls,
    failedUrls,
    reason: null,
  };
}
