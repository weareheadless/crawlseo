import { createHash } from "node:crypto";
import { db } from "@/lib/db";

export type CoverageInput = {
  projectId: string; findingId: string;
  evidence: { documentId: string; fieldPath: string; revision: number };
  section: { key: string; contentHash: string };
  service: string; audience: string; locale: string;
  status: "covered" | "unresolved";
  missingEvidence?: string | null;
  reasonCode?: "no_evidence" | "disputed_evidence" | "stale_hash" | "unusable_publication_use" | null;
};

export function hashSection(content: string) { return createHash("sha256").update(content).digest("hex"); }

export async function recordQuestionCoverage(input: CoverageInput) {
  if (input.status === "unresolved" && !input.missingEvidence?.trim()) throw new Error("missingEvidence is required for unresolved coverage");
  const finding = await db.researchFinding.findFirst({ where: { id: input.findingId, run: { projectId: input.projectId } }, select: { id: true } });
  if (!finding) throw new Error("Finding does not belong to project");
  const rev = await db.businessKnowledgeRevision.findFirst({ where: { documentId: input.evidence.documentId, revision: input.evidence.revision }, select: { fields: true } });
  const fields = rev?.fields && typeof rev.fields === "object" ? rev.fields as Record<string, unknown> : {};
  const fact = fields[input.evidence.fieldPath] as { provenance?: { status?: string }; publicationUse?: string } | undefined;
  if (!fact?.provenance) throw new Error("Referenced evidence field or provenance does not exist");

  const existing = await db.questionCoverage.findUnique({ where: { projectId_findingId_sectionIdentity: {
    projectId: input.projectId, findingId: input.findingId, sectionIdentity: input.section.key,
  } }, select: { contentHash: true } });
  let status = input.status;
  let reason = input.reasonCode?.toUpperCase() as "NO_EVIDENCE" | "DISPUTED_EVIDENCE" | "STALE_HASH" | "UNUSABLE_PUBLICATION_USE" | undefined;
  let missingEvidence = input.missingEvidence?.trim() || null;
  if (status === "covered") {
    if (!["owner_confirmed", "admin_confirmed", "verified"].includes(fact.provenance.status ?? "")) {
      status = "unresolved"; reason = "DISPUTED_EVIDENCE"; missingEvidence = "Evidence provenance is not confirmed or verified.";
    } else if (fact.publicationUse !== "approved") {
      status = "unresolved"; reason = "UNUSABLE_PUBLICATION_USE"; missingEvidence = "Evidence is not approved for publication.";
    } else if (existing && existing.contentHash !== input.section.contentHash) {
      status = "unresolved"; reason = "STALE_HASH"; missingEvidence = "Section content hash changed; coverage needs revalidation.";
    }
  }
  if (status === "unresolved" && !missingEvidence) throw new Error("missingEvidence is required for unresolved coverage");
  return db.questionCoverage.upsert({
    where: { projectId_findingId_sectionIdentity: { projectId: input.projectId, findingId: input.findingId, sectionIdentity: input.section.key } },
    create: { projectId: input.projectId, findingId: input.findingId, service: input.service, audience: input.audience, locale: input.locale,
      sectionIdentity: input.section.key, contentHash: input.section.contentHash, status: status.toUpperCase() as "COVERED" | "UNRESOLVED",
      documentId: input.evidence.documentId, fieldPath: input.evidence.fieldPath, evidenceRevision: input.evidence.revision,
      missingEvidence, reason: reason ?? null, requestedAt: status === "unresolved" ? new Date() : null },
    update: { service: input.service, audience: input.audience, locale: input.locale, contentHash: input.section.contentHash,
      status: status.toUpperCase() as "COVERED" | "UNRESOLVED", documentId: input.evidence.documentId,
      fieldPath: input.evidence.fieldPath, evidenceRevision: input.evidence.revision, missingEvidence, reason: reason ?? null,
      requestedAt: status === "unresolved" ? new Date() : null },
  });
}
