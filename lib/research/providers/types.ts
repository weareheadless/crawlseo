/**
 * The shape every research provider returns.
 *
 * It lived in the Reddit RSS provider, which was the first one written. Reddit no
 * longer permits direct reading, so the type moved here rather than following one
 * provider out of the codebase.
 */
export type ResearchProviderSource = {
  provider: string;
  url: string;
  title: string;
  author?: string;
  community?: string;
  publishedAt?: string;
  excerpt?: string;
  contentHash: string;
  language?: string;
  metadata?: Record<string, unknown>;
};
