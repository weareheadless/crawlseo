/**
 * Cicero's social lane, as two calls.
 *
 * Cicero owns the Page, the token and the draft flag; CrawlSEO owns the
 * opportunity and the receipt. Nothing here knows a page id or a Meta endpoint —
 * if this file ever needs one, the ownership is wrong.
 *
 * The caller names the site it is acting for, not a credential: Cicero resolves
 * the brand from that site id, so no service holds a token per tenant.
 */

export type CiceroConfig = { url: string; token: string };

export function ciceroConfig(): CiceroConfig | null {
  const url = (process.env.CICERO_URL ?? "").replace(/\/+$/, "");
  const token = process.env.INTERNAL_SERVICE_TOKEN ?? "";
  if (!url || !token) return null;
  return { url, token };
}

export function ciceroEnabled(): boolean {
  return ciceroConfig() !== null;
}

export type SocialArtifactPayload = {
  id: string;
  channel: "facebook_page";
  locale: string;
  page_url?: string;
  subject?: string;
  copy: {
    kicker: string;
    headline: string;
    subline: string;
    caption: string;
    facts?: Array<{ text: string; source_url: string }>;
  };
  assets: Array<{ path?: string; url?: string; alt: string; credit?: string }>;
  content_hash: string;
};

export type RenderOutcome =
  | {
      outcome: "rendered";
      renderId: string;
      contentHash: string;
      caption: string;
      image: string;
      brandRevision: string;
    }
  | { outcome: "refused"; code: string; detail: string; retryable: boolean };

export type PublishOutcome =
  | {
      outcome: "accepted";
      status: "published" | "draft" | "scheduled" | "unknown";
      providerPostId: string | null;
      draft: boolean;
      /** Set when the Page holds the post for a time rather than showing it now. */
      scheduledFor?: string;
    }
  | { outcome: "refused"; code: string; detail: string; retryable: boolean };

export type SocialHistoryItem = {
  renderId: string;
  createdAt: string;
  pageUrl: string;
  subject: string;
  onImage: string[];
  assets: string[];
  facts: string[];
  caption: string;
};

export type CiceroClient = {
  render(input: {
    artifact: SocialArtifactPayload;
    artDirection: string;
  }): Promise<RenderOutcome>;
  publish(input: {
    renderId: string;
    idempotencyKey: string;
    draft?: boolean;
    caption?: string;
    /** ISO 8601 with an offset: schedule instead of publishing now. */
    scheduledAt?: string;
  }): Promise<PublishOutcome>;
  /** Recent renders, newest first: the pages and photographs already used. */
  history(limit?: number): Promise<SocialHistoryItem[]>;
};

/** What a status code means for the caller. A 5xx may be retried; a 409 may not. */
function refusalFor(status: number, detail: string): { code: string; detail: string; retryable: boolean } {
  if (status === 409) return { code: "NO_PAGE_CONNECTED", detail, retryable: false };
  if (status === 410) return { code: "RENDER_GONE", detail, retryable: true };
  if (status === 401 || status === 403) return { code: "CICERO_UNAUTHORIZED", detail, retryable: false };
  if (status === 404) return { code: "CICERO_NOT_FOUND", detail, retryable: false };
  if (status === 400 || status === 422) return { code: "CICERO_REFUSED", detail, retryable: false };
  return { code: "CICERO_UNAVAILABLE", detail, retryable: status >= 500 };
}

export function createCiceroClient(options: {
  siteId: string;
  fetchImpl?: typeof fetch;
}): CiceroClient {
  const call = options.fetchImpl ?? fetch;

  async function request(path: string, body: unknown): Promise<{ status: number; payload: any }> {
    const config = ciceroConfig();
    if (!config) throw new Error("Cicero is not configured");
    let response: Response;
    try {
      response = await call(`${config.url}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(120_000),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.token}`,
          "x-crawlseo-site-id": options.siteId,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // A transport failure on a POST may have reached Cicero; the publication
      // receipt protects us, so this is retryable at the publish step and only
      // a failed render at the render step.
      throw new Error(`Cicero request failed: ${(error as Error).message}`);
    }
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { detail: text.slice(0, 500) };
    }
    return { status: response.status, payload };
  }

  return {
    async render({ artifact, artDirection }) {
      const { status, payload } = await request("/v1/social/renders", {
        artifact,
        art_direction: artDirection,
      });
      if (status === 200) {
        return {
          outcome: "rendered",
          renderId: String(payload.render_id ?? ""),
          contentHash: String(payload.content_hash ?? ""),
          caption: String(payload.caption ?? artifact.copy.caption ?? ""),
          image: String(payload.image ?? ""),
          brandRevision: String(payload.brand_revision ?? ""),
        };
      }
      const detail = payload?.detail;
      const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? `Cicero returned ${status}`);
      return { outcome: "refused", ...refusalFor(status, text) };
    },

    async publish({ renderId, idempotencyKey, draft, caption, scheduledAt }) {
      const { status, payload } = await request("/v1/social/publications", {
        render_id: renderId,
        idempotency_key: idempotencyKey,
        draft,
        caption,
        ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
      });
      if (status === 200) {
        const reported = String(payload.status ?? "");
        const outcome =
          reported === "unknown"
            ? "unknown"
            : reported === "scheduled"
              ? "scheduled"
              : reported === "draft"
                ? "draft"
                : "published";
        return {
          outcome: "accepted",
          status: outcome,
          providerPostId: payload.provider_post_id ? String(payload.provider_post_id) : null,
          draft: Boolean(payload.draft),
          ...(payload.scheduled_for ? { scheduledFor: String(payload.scheduled_for) } : {}),
        };
      }
      const detail = payload?.detail;
      const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? `Cicero returned ${status}`);
      return { outcome: "refused", ...refusalFor(status, text) };
    },

    async history(limit = 8) {
      const config = ciceroConfig();
      if (!config) return [];
      const query = new URLSearchParams({ limit: String(limit) });
      const response = await call(`${config.url}/v1/social/renders?${query.toString()}`, {
        method: "GET",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${config.token}`,
          "x-crawlseo-site-id": options.siteId,
        },
      });
      if (!response.ok) {
        throw new Error(`Cicero history failed: ${response.status}`);
      }
      const payload: any = await response.json();
      return (Array.isArray(payload?.items) ? payload.items : []).map((item: any) => ({
        renderId: String(item?.render_id ?? ""),
        createdAt: String(item?.created_at ?? ""),
        pageUrl: String(item?.page_url ?? ""),
        subject: String(item?.subject ?? ""),
        onImage: Array.isArray(item?.on_image) ? item.on_image.map(String) : [],
        assets: Array.isArray(item?.assets) ? item.assets.map(String) : [],
        facts: Array.isArray(item?.facts) ? item.facts.map(String) : [],
        caption: String(item?.caption ?? ""),
      }));
    },
  };
}
