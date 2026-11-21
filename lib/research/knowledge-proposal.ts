import type { PrismaClient } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { writeBusinessKnowledge, type BusinessKnowledgeFields } from "@/lib/projects/business-knowledge";
import { knowledgeFactMeta, knowledgeFactValue } from "@/lib/projects/business-knowledge-facts";

/**
 * Research → business knowledge, as a proposal the owner still has to accept.
 *
 * Findings say what buyers care about in their own words. That is knowledge the
 * why-leg should be able to cite, but it is not owner-confirmed fact: the write
 * goes in as `research_observation` / `advised` / `internal_only`, next to a
 * source URL, and a confirmed field is never overwritten. There is no review
 * queue table — the working revision and its provenance status are the queue.
 */

/** Fields the proposal may write. Everything else stays the owner's or intake's. */
const PROPOSABLE_FIELDS = [
  "businessName", "services", "location", "serviceArea", "differentiators",
  "audienceMotivations", "concerns", "conversionGoals", "voice", "prohibitedClaims",
] as const;

/** Provenance statuses that mean a person already settled the value. */
const CONFIRMED_STATUSES = new Set(["owner_confirmed", "admin_confirmed", "verified"]);

const MAX_FINDINGS = 8;
const MAX_SUMMARY_CHARS = 600;
const MAX_FIELD_ITEMS = 30;
const MAX_ITEM_CHARS = 500;

export type KnowledgeProposalResult = {
  /** Fields written to a new working revision. */
  proposed: string[];
  /** Fields left alone because a person already confirmed them. */
  skippedConfirmed: string[];
  /** Fields the model re-proposed unchanged: no revision was written for them. */
  unchanged: string[];
  /** Proposals the contract refused, with the reason. */
  rejected: Array<{ field: string; reason: string }>;
  /** Revision written, or null when nothing changed. */
  revision: number | null;
  /** Findings sent to the model, and how many the run had. */
  findingsSent: number;
  findingsTotal: number;
  /** Set when the step could not run at all (not configured, no findings). */
  note: string | null;
};

type Db = Pick<
  PrismaClient,
  "researchFinding" | "researchSource" | "businessKnowledgeDocument" | "businessKnowledgeRevision" | "project"
>;

export async function proposeKnowledgeFromResearch(
  db: Db,
  opts: { projectId: string; siteId?: string | null; runId: string }
): Promise<KnowledgeProposalResult> {
  const empty: KnowledgeProposalResult = {
    proposed: [], skippedConfirmed: [], unchanged: [], rejected: [],
    revision: null, findingsSent: 0, findingsTotal: 0, note: null,
  };

  const findings = await db.researchFinding.findMany({
    where: { runId: opts.runId },
    select: { id: true, type: true, theme: true, summary: true, demandQueries: true, evidenceSourceIds: true },
    // Newest first: the bound below must not keep the oldest findings and drop
    // the ones this run just produced.
    orderBy: { createdAt: "desc" },
  });
  if (findings.length === 0) return { ...empty, note: "the run produced no findings" };

  const config = contentWriterConfig();
  if (!config) return { ...empty, findingsTotal: findings.length, note: "the content model is not configured" };

  const head = await db.businessKnowledgeDocument.findUnique({
    where: { projectId: opts.projectId },
    select: { logicalId: true, revision: true, revisions: { orderBy: { revision: "desc" }, take: 1, select: { fields: true } } },
  });
  const currentFields = (head?.revisions[0]?.fields ?? {}) as Record<string, unknown>;
  const currentValues = Object.fromEntries(
    Object.entries(currentFields).map(([field, value]) => [field, knowledgeFactValue(value)])
  );

  // Every finding's source URLs are needed to attribute a proposed field to the
  // page that supports it.
  const sourceIds = [...new Set(findings.flatMap((finding) =>
    Array.isArray(finding.evidenceSourceIds)
      ? finding.evidenceSourceIds.filter((id): id is string => typeof id === "string")
      : []
  ))];
  const sources = sourceIds.length
    ? await db.researchSource.findMany({ where: { id: { in: sourceIds } }, select: { id: true, url: true } })
    : [];
  const urlBySource = new Map(sources.map((source) => [source.id, source.url]));

  const sent = findings.slice(0, MAX_FINDINGS);
  const payload = sent.map((finding, index) => ({
    index,
    type: finding.type,
    theme: finding.theme,
    summary: finding.summary.slice(0, MAX_SUMMARY_CHARS),
    demandQueries: finding.demandQueries ?? [],
    sourceUrls: (Array.isArray(finding.evidenceSourceIds) ? finding.evidenceSourceIds : [])
      .filter((id): id is string => typeof id === "string")
      .map((id) => urlBySource.get(id))
      .filter((url): url is string => Boolean(url)),
  }));

  const system = [
    "You maintain a company's business-knowledge document from market research findings.",
    "Return only facts the findings actually support, in the language of the findings.",
    "Never restate a finding's opinion as a confirmed business fact, and never invent a number, price, or legal rule.",
    `Allowed fields: ${PROPOSABLE_FIELDS.join(", ")}.`,
    "businessName, location and voice are single strings; the others are short lists.",
    "Return exactly one JSON object: { updates: [{ field, value, finding_indexes: [n] }] }.",
    "Omit a field when the findings add nothing to it. Return { updates: [] } when nothing is supported.",
  ].join("\n");

  let decoded: unknown;
  try {
    decoded = await chatJson({
      config,
      system,
      user: JSON.stringify({ current: currentValues, findings: payload }),
      maxTokens: 4_000,
      attempts: 3,
    });
  } catch (error) {
    return { ...empty, findingsTotal: findings.length, findingsSent: sent.length,
      note: error instanceof Error ? error.message.slice(0, 240) : "the model call failed" };
  }

  const rows = Array.isArray((decoded as { updates?: unknown })?.updates) ? (decoded as { updates: unknown[] }).updates : [];
  const changes: Record<string, unknown> = {};
  const proposed: string[] = [];
  const skippedConfirmed: string[] = [];
  const unchanged: string[] = [];
  const rejected: Array<{ field: string; reason: string }> = [];

  for (const raw of rows.slice(0, PROPOSABLE_FIELDS.length)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as { field?: unknown; value?: unknown; finding_indexes?: unknown };
    const field = typeof row.field === "string" ? row.field : "";
    if (!(PROPOSABLE_FIELDS as readonly string[]).includes(field)) {
      rejected.push({ field: field || "unknown", reason: "field is not proposable from research" });
      continue;
    }
    const existing = currentFields[field];
    if (existing && CONFIRMED_STATUSES.has(knowledgeFactMeta(existing).provenanceStatus)) {
      skippedConfirmed.push(field);
      continue;
    }

    const value = Array.isArray(row.value)
      ? row.value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, MAX_ITEM_CHARS)).slice(0, MAX_FIELD_ITEMS)
      : typeof row.value === "string" && row.value.trim() ? row.value.trim().slice(0, MAX_ITEM_CHARS) : null;
    if (!value || (Array.isArray(value) && value.length === 0)) {
      rejected.push({ field, reason: "no usable value" });
      continue;
    }

    // The write must be attributable: a proposal that names no finding index has
    // no evidence URI, and the owner cannot check where it came from.
    const indexes = Array.isArray(row.finding_indexes)
      ? row.finding_indexes.filter((index): index is number => Number.isInteger(index) && index >= 0 && index < sent.length)
      : [];
    const evidenceUri = indexes
      .flatMap((index) => payload[index].sourceUrls)
      .find((url): url is string => typeof url === "string");
    if (!evidenceUri) {
      rejected.push({ field, reason: "no source URL could be attributed" });
      continue;
    }

    const previous = knowledgeFactValue(existing).join("; ");
    const next = Array.isArray(value) ? value.join("; ") : value;
    if (previous && previous === next) {
      unchanged.push(field);
      continue;
    }

    const now = new Date().toISOString();
    changes[field] = {
      value,
      provenance: {
        kind: "research_observation",
        sourceId: "research-bridge",
        originSystem: "crawlseo",
        originRecordId: opts.runId.slice(0, 100),
        originRevision: null,
        actor: { type: "researcher", id: "research-bridge" },
        status: "advised",
        recordedAt: now,
        observedAt: now,
        evidenceUri,
      },
      publicationUse: "internal_only",
    };
    proposed.push(field);
  }

  if (proposed.length === 0) {
    return { proposed, skippedConfirmed, unchanged, rejected, revision: null, findingsSent: sent.length, findingsTotal: findings.length, note: null };
  }

  const project = await db.project.findUniqueOrThrow({ where: { id: opts.projectId }, select: { workspaceId: true } });
  try {
    const written = await writeBusinessKnowledge(
      {
        workspaceId: project.workspaceId,
        projectId: opts.projectId,
        documentId: head?.logicalId ?? `business-${opts.projectId}`,
        expectedRevision: head?.revision ?? 0,
        idempotencyKey: `research-bridge:${opts.runId}`,
        reason: "Proposed from market research findings; unverified, not owner-confirmed",
        changes: changes as BusinessKnowledgeFields,
      },
      {
        credentialId: "internal-research-bridge",
        servicePrincipalId: "research-bridge",
        workspaceId: project.workspaceId,
        projectId: opts.projectId,
        scopes: ["document:write"],
      }
    );
    return { proposed, skippedConfirmed, unchanged, rejected, revision: written.revision, findingsSent: sent.length, findingsTotal: findings.length, note: null };
  } catch (error) {
    return { proposed: [], skippedConfirmed, unchanged, rejected, revision: null, findingsSent: sent.length, findingsTotal: findings.length,
      note: error instanceof Error ? error.message.slice(0, 240) : "the knowledge write failed" };
  }
}
