import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord } from "@/lib/funnel/evidence";

/**
 * Bridge: canonical business knowledge → `knowledge_fact` evidence.
 *
 * The document is owner-sourced (`BusinessKnowledgeDocument`), so this bridge
 * never infers a fact: it projects the accepted (or latest) revision's fields,
 * one evidence row per field, with the provenance status and publication use the
 * owner recorded. That is what lets O6 compare a fact and O8 carry a why leg.
 *
 * A project with no document produces nothing, which is the honest state: the
 * why leg is missing because the owner has not written it, not because the
 * detector ignored it.
 */

export type BusinessKnowledgeDb = Pick<PrismaClient, "businessKnowledgeDocument"> &
  Parameters<typeof storeEvidenceRecord>[0];

export type BusinessKnowledgeBridgeResult = {
  document: boolean;
  revision: number | null;
  stored: number;
  skipped: Array<{ field: string; reason: string }>;
};

type Fact = {
  value?: unknown;
  provenance?: { status?: string; kind?: string; actor?: { type?: string }; recordedAt?: string };
  publicationUse?: string;
};

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join("; ") : null;
  }
  return null;
}

export async function bridgeBusinessKnowledgeToEvidence(
  db: BusinessKnowledgeDb,
  opts: { projectId: string; siteId?: string | null; observedAt?: Date }
): Promise<BusinessKnowledgeBridgeResult> {
  const document = await db.businessKnowledgeDocument.findUnique({
    where: { projectId: opts.projectId },
    select: {
      revision: true,
      acceptedRevision: true,
      revisions: {
        orderBy: { revision: "desc" },
        select: { revision: true, fields: true, createdAt: true },
      },
    },
  });
  if (!document) return { document: false, revision: null, stored: 0, skipped: [] };

  const wanted = document.acceptedRevision ?? document.revision;
  const revision = document.revisions.find((row) => row.revision === wanted) ?? document.revisions[0];
  if (!revision) return { document: true, revision: null, stored: 0, skipped: [] };

  const fields = (revision.fields ?? {}) as Record<string, Fact>;
  const result: BusinessKnowledgeBridgeResult = { document: true, revision: revision.revision, stored: 0, skipped: [] };

  for (const [field, fact] of Object.entries(fields)) {
    const value = stringValue(fact?.value);
    if (!value) {
      result.skipped.push({ field, reason: "no usable value" });
      continue;
    }
    const stored = await storeEvidenceRecord(db, {
      projectId: opts.projectId,
      siteId: opts.siteId ?? null,
      kind: "knowledge_fact",
      observedAt: opts.observedAt ?? revision.createdAt,
      producer: "business_knowledge",
      dimensions: {
        field,
        // O6 compares crawl content to a fact by question; the field name is the
        // question the owner answered.
        question: field,
        value,
        publicationUse: fact?.publicationUse ?? "unknown",
        provenanceStatus: fact?.provenance?.status ?? "unknown",
        provenanceKind: fact?.provenance?.kind ?? "unknown",
      },
      metrics: {},
    });
    // A new revision supersedes the previous fact for the same field, so the why
    // leg never attaches a stale value.
    await db.evidenceRecord.updateMany({
      where: {
        projectId: opts.projectId,
        kind: "knowledge_fact",
        supersededById: null,
        id: { not: stored.id },
        dimensions: { path: ["field"], equals: field },
      },
      data: { supersededById: stored.id },
    });
    result.stored += 1;
  }

  return result;
}
