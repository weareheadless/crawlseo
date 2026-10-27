import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { createResearchAction, updateResearchAction } from "@/lib/research/service";

export type CoverageInput = {
  projectId: string; findingId: string;
  evidence?: { documentId: string; fieldPath: string; revision: number };
  section: { key: string; contentHash: string };
  service: string; audience: string; locale: string;
  status: "covered" | "unresolved";
  missingEvidence?: string | null;
  reasonCode?: "no_evidence" | "disputed_evidence" | "stale_hash" | "unusable_publication_use" | null;
  revalidated?: boolean;
};

export function hashSection(content: string) { return createHash("sha256").update(content).digest("hex"); }

/** Stable provider-neutral identity for the complete written draft candidate. */
export function hashContentDraft(draft: { id: string; siteId: string; actionId: string | null; title: string; slug: string; metaTitle: string; metaDescription: string; excerpt: string; markdown: string }) {
  return createHash("sha256").update(JSON.stringify(draft)).digest("hex");
}

export async function recordDraftCoverage(contentDraftId: string, evidence?: CoverageInput["evidence"]) {
  const draft = await db.contentDraft.findUnique({ where: { id: contentDraftId }, include: { action: { select: { id: true, findingId: true, projectId: true } }, site: { select: { projectId: true } } } });
  if (!draft) throw new Error("Content draft not found");
  const findingId = draft.action?.findingId;
  const projectId = draft.action?.projectId ?? draft.site?.projectId;
  if (!findingId || !projectId) return { recorded: 0 };
  const finding = await db.researchFinding.findUnique({ where: { id: findingId }, select: { summary: true, theme: true } });
  if (!finding) return { recorded: 0 };
  const revision = evidence ? await db.businessKnowledgeRevision.findFirst({ where: { documentId: evidence.documentId, revision: evidence.revision }, select: { fields: true } }) : null;
  const revFields = revision?.fields && typeof revision.fields === "object" ? revision.fields as Record<string, unknown> : {};
  const fact = evidence ? revFields[evidence.fieldPath] as { provenance?: { status?: string }; publicationUse?: string } | undefined : undefined;
  const usableEvidence = Boolean(fact?.provenance && ["owner_confirmed", "admin_confirmed", "verified"].includes(fact.provenance.status ?? "") && fact.publicationUse === "approved");
  const section = { key: draft.id, contentHash: hashContentDraft({ id: draft.id, siteId: draft.siteId, actionId: draft.actionId, title: draft.title, slug: draft.slug, metaTitle: draft.metaTitle, metaDescription: draft.metaDescription, excerpt: draft.excerpt, markdown: draft.markdown }) };
  const prior = await db.questionCoverage.findUnique({ where: { projectId_findingId_sectionIdentity: { projectId, findingId, sectionIdentity: draft.id } }, select: { contentHash: true } });
  const changed = Boolean(prior && prior.contentHash !== section.contentHash);
  const missingEvidence = usableEvidence ? null : `Unlinked question: ${finding.summary}`;
  return recordQuestionCoverage({ projectId, findingId, evidence: usableEvidence ? evidence : undefined, section, service: finding.theme, audience: "site visitors", locale: "und", status: usableEvidence ? "covered" : "unresolved", missingEvidence, reasonCode: usableEvidence ? null : changed ? "stale_hash" : "no_evidence", revalidated: usableEvidence });
}

export async function recordQuestionCoverage(input: CoverageInput) {
  if (input.status === "unresolved" && !input.missingEvidence?.trim()) throw new Error("missingEvidence is required for unresolved coverage");
  const finding = await db.researchFinding.findFirst({ where: { id: input.findingId, run: { projectId: input.projectId } }, select: { id: true, summary: true, theme: true, runId: true, run: { select: { siteId: true } } } });
  if (!finding) throw new Error("Finding does not belong to project");
  const rev = input.evidence ? await db.businessKnowledgeRevision.findFirst({ where: { documentId: input.evidence.documentId, revision: input.evidence.revision }, select: { fields: true } }) : null;
  const fields = rev?.fields && typeof rev.fields === "object" ? rev.fields as Record<string, unknown> : {};
  const fact = input.evidence ? fields[input.evidence.fieldPath] as { provenance?: { status?: string }; publicationUse?: string } | undefined : undefined;
  if (input.status === "covered" && !fact?.provenance) throw new Error("Referenced evidence field or provenance does not exist");

  const existing = await db.questionCoverage.findUnique({ where: { projectId_findingId_sectionIdentity: {
    projectId: input.projectId, findingId: input.findingId, sectionIdentity: input.section.key,
  } }, select: { contentHash: true } });
  let status = input.status;
  let reason = input.reasonCode?.toUpperCase() as "NO_EVIDENCE" | "DISPUTED_EVIDENCE" | "STALE_HASH" | "UNUSABLE_PUBLICATION_USE" | undefined;
  let missingEvidence = input.missingEvidence?.trim() || null;
  if (status === "covered") {
    if (!fact?.provenance || !["owner_confirmed", "admin_confirmed", "verified"].includes(fact.provenance.status ?? "")) {
      status = "unresolved"; reason = "DISPUTED_EVIDENCE"; missingEvidence = "Evidence provenance is not confirmed or verified.";
    } else if (fact.publicationUse !== "approved") {
      status = "unresolved"; reason = "UNUSABLE_PUBLICATION_USE"; missingEvidence = "Evidence is not approved for publication.";
    } else if (existing && existing.contentHash !== input.section.contentHash && !input.revalidated) {
      status = "unresolved"; reason = "STALE_HASH"; missingEvidence = "Section content hash changed; coverage needs revalidation.";
    }
  }
  if (status === "unresolved" && !missingEvidence) throw new Error("missingEvidence is required for unresolved coverage");
  const coverage = await db.questionCoverage.upsert({
    where: { projectId_findingId_sectionIdentity: { projectId: input.projectId, findingId: input.findingId, sectionIdentity: input.section.key } },
    create: { projectId: input.projectId, findingId: input.findingId, service: input.service, audience: input.audience, locale: input.locale,
      sectionIdentity: input.section.key, contentHash: input.section.contentHash, status: status.toUpperCase() as "COVERED" | "UNRESOLVED",
      documentId: input.evidence?.documentId ?? null, fieldPath: input.evidence?.fieldPath ?? null, evidenceRevision: input.evidence?.revision ?? null,
      missingEvidence, reason: reason ?? null, requestedAt: status === "unresolved" ? new Date() : null },
    update: { service: input.service, audience: input.audience, locale: input.locale, contentHash: input.section.contentHash,
      status: status.toUpperCase() as "COVERED" | "UNRESOLVED", documentId: input.evidence?.documentId ?? null,
      fieldPath: input.evidence?.fieldPath ?? null, evidenceRevision: input.evidence?.revision ?? null, missingEvidence, reason: reason ?? null,
      requestedAt: status === "unresolved" ? new Date() : null },
  });
  if (status === "unresolved" && missingEvidence) {
    const result = await createResearchAction(finding.run.siteId, {
      runId: finding.runId, findingId: finding.id, source: "ai_visibility_coverage", kind: "missing_evidence",
      title: `Provide evidence for: ${finding.summary.slice(0, 180)}`,
      primaryQuery: `${input.projectId}:${input.findingId}:${input.section.key}`,
      recommendation: `Supply this evidence request: ${missingEvidence}. Close this Action when the same question coverage is supported by confirmed, publication-approved evidence. This request does not assert the underlying fact.`,
      acceptanceCriteria: ["The question coverage for this section is recorded as covered using confirmed, publication-approved evidence."],
      evidence: { question_coverage_id: coverage.id, missing_evidence: missingEvidence, outcome: "unknown_until_coverage_resolves" },
      dedupeKey: `question-coverage:${input.projectId}:${input.findingId}:${input.section.key}`,
      priority: 50, automationMode: "MANUAL",
    }, "system:question-coverage");
    await db.questionCoverage.update({ where: { id: coverage.id }, data: { actionId: result.action.id } });
    return { ...coverage, actionId: result.action.id };
  }
  if (status === "covered" && coverage.actionId) {
    const action = await db.researchAction.findUnique({ where: { id: coverage.actionId }, select: { id: true, status: true } });
    if (action && !["DISMISSED", "VERIFIED", "FULFILLED", "FAILED"].includes(action.status)) {
      await updateResearchAction(action.id, { status: "FULFILLED" }, "system:question-coverage");
    }
  }
  return coverage;
}
