import type { ContentDraft } from "@prisma/client";

export type ContentDraftView = {
  id: string;
  actionKind: string;
  format: string;
  primaryQuery: string;
  targetUrl: string | null;
  intent: string;
  title: string;
  slug: string;
  metaTitle: string;
  metaDescription: string;
  excerpt: string;
  markdown: string;
  outline: string[];
  model: string;
  provider: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function contentDraftView(draft: ContentDraft): ContentDraftView {
  return {
    id: draft.id,
    actionKind: draft.actionKind,
    format: draft.format,
    primaryQuery: draft.primaryQuery,
    targetUrl: draft.targetUrl,
    intent: draft.intent,
    title: draft.title,
    slug: draft.slug,
    metaTitle: draft.metaTitle,
    metaDescription: draft.metaDescription,
    excerpt: draft.excerpt,
    markdown: draft.markdown,
    outline: Array.isArray(draft.outline)
      ? draft.outline.filter((item): item is string => typeof item === "string")
      : [],
    model: draft.model,
    provider: draft.provider,
    status: draft.status,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}
