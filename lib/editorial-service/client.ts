import { ResearchServiceError } from "@/lib/research/service";

/**
 * HTTP client for the editorial service.
 *
 * Editorial writes and verifies; CrawlSEO owns approval and delivery. This
 * client only creates a brief, reads the post back and hands the artifact to
 * the article lane — it never asks editorial to publish.
 */

export type EditorialArtifact = {
  locale: string;
  revision: number;
  status: "draft" | "verified" | "held" | "published";
  title: string;
  dek: string;
  slug: string;
  body_markdown: string;
  outline: string[];
  excerpt: string;
  meta_title: string;
  meta_description: string;
  primary_keyword: string;
  tags: string[];
  category: string;
  quote_pull: string;
  content_hash: string;
  claims: Array<{ text: string; verdict: "pending" | "supported" | "unsupported" | "removed" }>;
  sources: Array<{ id: string; url: string; title: string; sha256: string }>;
  coverage: Record<string, unknown>;
  editorial: Record<string, unknown>;
};

export type EditorialPost = {
  id: string;
  tenant: string;
  state: string;
  error: string;
  artifacts: Record<string, EditorialArtifact>;
  receipts: Array<{ locale: string; verified: boolean; url: string }>;
  events: Array<{ type: string; data: Record<string, unknown>; at: string }>;
};

export type EditorialConfig = { url: string; token: string };

export function editorialConfig(): EditorialConfig | null {
  const url = (process.env.EDITORIAL_URL ?? "").replace(/\/+$/, "");
  const token = process.env.EDITORIAL_TOKEN ?? "";
  if (!url || !token) return null;
  return { url, token };
}

export function editorialEnabled(): boolean {
  return editorialConfig() !== null;
}

async function request(
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const config = editorialConfig();
  if (!config) throw new ResearchServiceError("The editorial service is not configured", 503);
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
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

export async function createEditorialPost(brief: Record<string, unknown>): Promise<{ postId: string; state: string }> {
  const { status, body } = await request("/v1/posts", {
    method: "POST",
    body: JSON.stringify(brief),
  });
  if (status !== 202 && status !== 200) {
    throw new ResearchServiceError(
      `Editorial refused the brief (${status}): ${JSON.stringify(body).slice(0, 500)}`,
      502,
    );
  }
  const postId = (body as { post_id?: string } | null)?.post_id;
  if (!postId) throw new ResearchServiceError("Editorial returned no post id", 502);
  return { postId, state: (body as { state?: string }).state ?? "queued" };
}

export async function getEditorialPost(postId: string): Promise<EditorialPost> {
  const { status, body } = await request(`/v1/posts/${encodeURIComponent(postId)}`, { method: "GET" });
  if (status === 404) throw new ResearchServiceError("The editorial post no longer exists", 404);
  if (status !== 200) {
    throw new ResearchServiceError(
      `Editorial could not report the post (${status}): ${JSON.stringify(body).slice(0, 500)}`,
      502,
    );
  }
  return body as EditorialPost;
}

/** States where the service will not change the artifact again by itself. */
export function editorialTerminal(state: string): boolean {
  return ["ready", "published", "held", "failed", "cancelled"].includes(state);
}
