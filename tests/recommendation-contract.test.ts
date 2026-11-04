import { describe, expect, it } from "vitest";

import {
  finaliseDecision,
  hashPacket,
  sealPacket,
  validateDecision,
  type EvidencePacket,
  type ModelDecision,
} from "@/lib/recommendation/contracts";
import { publishDecision } from "@/lib/recommendation/publish";

/**
 * Deterministic integrity tests for the canonical recommendation contract.
 *
 * These prove that an invalid decision cannot be published. They do not prove
 * that the model reasons well about a real business; that is the separate
 * same-evidence evaluation.
 */

function packet(over: Partial<EvidencePacket> = {}): EvidencePacket {
  const base = sealPacket({
    projectId: "p1",
    siteId: "s1",
    policyVersion: "recommendation-policy/1",
    candidate: {
      findingId: "f1",
      findingType: "CONCERN",
      theme: "Warranty claim documents",
      summary: "Customers ask which documents a warranty claim needs.",
      premise: "The warranty page does not explain the required documents.",
      observedAt: "2026-11-04T00:00:00.000Z",
      dedupKey: "O13:warranty claim documents",
      sourceIds: ["s1"],
    },
    businessFacts: [{
      id: "fact:services",
      field: "services",
      value: "Appliance repairs",
      sourceUrl: "https://site.test/about",
      provenanceKind: "ai_observation",
      provenanceStatus: "assumed",
      publicationUse: "internal_only",
      documentRevision: 1,
    }],
    context: { language: "en", audience: "homeowners", market: "United Kingdom", marketSource: "site_profile" },
    sources: [{
      id: "source:s1",
      url: "https://forum.test/claim",
      title: "Which documents?",
      provider: "community",
      excerpt: "I could not find which documents to send for a repair claim.",
      observedAt: "2026-11-01T00:00:00.000Z",
      language: "en",
    }],
    pages: [{
      id: "page:p1",
      url: "https://site.test/warranty",
      title: "Warranty",
      contentHash: "h1",
      text: "Our warranty covers repairs for twelve months. Contact our team for help.",
      truncated: false,
      retrieval: "stored",
      status: 200,
      language: "en",
      sections: [{ id: "section:p1:0", locator: "chars:0-70", text: "Our warranty covers repairs for twelve months." }],
    }],
    inventory: [{ url: "https://site.test/warranty", title: "Warranty", status: 200, indexable: true, retrieval: "stored" }],
    search: [],
    limitations: [],
  });
  return { ...base, ...over };
}

function model(over: Partial<ModelDecision> = {}): ModelDecision {
  return {
    question: {
      text: "Which documents does a warranty claim need?",
      audience: "homeowners",
      journeyStage: "after purchase",
      bases: [{ basis: "observed_request", references: ["source:s1"], note: "A customer asks which documents to send." }],
      state: "supported",
      rationale: "A customer explicitly asks for the documents.",
    },
    premise: { state: "unverified", rationale: "The page does not settle the exact document list.", references: [] },
    offerFit: {
      state: "supported",
      rationale: "The business repairs appliances under warranty.",
      references: ["fact:services"],
    },
    coverage: [{
      pageId: "page:p1",
      state: "does_not_answer",
      rationale: "It states the duration but not the documents.",
      excerpts: [],
      limitations: [],
    }],
    readiness: "actionable",
    intervention: "update_page",
    change: "List the documents required for a warranty claim.",
    investigation: null,
    targets: [{ pageId: "page:p1", pageUrl: "https://site.test/warranty", sectionId: null, role: "update", rationale: "The warranty page is the natural place." }],
    benefits: [{
      track: "customer_value",
      mechanism: "A customer can submit a complete claim.",
      measurement: "unquantified",
      baselineReference: null,
      assumptions: [],
      uncertainty: ["Demand is not measured."],
    }],
    effort: { size: "small", rationale: "One section on an existing page.", uncertainty: [] },
    risks: [],
    reviews: [],
    success: { measure: "A customer can identify the required documents.", instrumentation: "unavailable", rationale: "No claim tracking is connected." },
    uncertainty: ["The warranty team must confirm the current list."],
    contradictions: [],
    reasons: ["A specific existing-page improvement is justified."],
    ...over,
  };
}

function decide(p: EvidencePacket, m: ModelDecision) {
  return finaliseDecision({ model: m, packet: p, modelName: "fixture-model", promptVersion: "recommendation-prompt/1" });
}

describe("canonical recommendation integrity", () => {
  it("accepts a complete, grounded decision", () => {
    const p = packet();
    const result = validateDecision(decide(p, model()), p);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("never lets an investigation become an implementation", () => {
    const p = packet();
    const decision = decide(p, model({
      readiness: "needs_investigation",
      intervention: "investigate",
      change: "Confirm which documents the warranty team actually requires.",
      investigation: {
        question: "Which documents does the warranty team require?",
        inspect: ["the warranty policy"],
        decisionCriteria: ["the team confirms the list"],
        deliverable: "A confirmed document list.",
      },
      targets: [],
    }));
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("must not carry an implementation change");
    expect(decision.intervention).toBe("investigate");
  });

  it("requires a checked inadequacy on the page it would change", () => {
    const p = packet();
    const decision = decide(p, model({
      targets: [{ pageId: "page:p1", pageUrl: "https://site.test/warranty", sectionId: null, role: "update", rationale: "Change it." }],
      coverage: [{ pageId: "page:p1", state: "answers", rationale: "It answers.", excerpts: ["Our warranty covers repairs for twelve months."], limitations: [] }],
    }));
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("no assessed inadequacy");
  });

  it("does not accept a site page as proof of a customer request", () => {
    const p = packet();
    const decision = decide(p, model({
      question: {
        ...model().question,
        bases: [{ basis: "observed_request", references: ["page:p1"], note: "The page mentions it." }],
      },
    }));
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("must cite research sources");
  });

  it("does not accept a contradicted premise without a checked page answer", () => {
    const p = packet();
    const decision = decide(p, model({
      premise: { state: "contradicted", rationale: "A forum says the site answers it.", references: ["source:s1"] },
      coverage: [{ pageId: "page:p1", state: "does_not_answer", rationale: "It does not answer.", excerpts: [], limitations: [] }],
    }));
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("contradicted premise needs");
  });

  it("does not create an asset from missing text or an empty assessment", () => {
    const p = packet();
    const decision = decide(p, model({
      intervention: "create_asset",
      targets: [],
      coverage: [],
    }));
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("create_asset needs at least one assessed page");
  });

  it("does not accept a quote that is not in the supplied text", () => {
    const p = packet();
    const decision = decide(p, model({
      coverage: [{
        pageId: "page:p1",
        state: "partially_answers",
        rationale: "It gives the duration.",
        excerpts: ["We charge a flat fee of 500 dollars."],
        limitations: [],
      }],
    }));
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("does not occur in the supplied text");
  });

  it("changes the packet hash when the supplied page text changes", () => {
    const p = packet();
    const changed = { ...p, pages: [{ ...p.pages[0], text: "Different text." }] };
    expect(hashPacket(changed)).not.toBe(p.packetHash);
  });

  it("keeps multiple review requirements and uncertainty in the decision", () => {
    const p = packet();
    const decision = decide(p, model({
      reviews: [
        { requirement: "legal", reason: "The claim wording is contractual." },
        { requirement: "technical", reason: "The claim form must be checked." },
      ],
      uncertainty: ["The document list may change."],
    }));
    expect(validateDecision(decision, p).ok).toBe(true);
    expect(decision.reviews.map((review) => review.requirement)).toEqual(["legal", "technical"]);
    expect(decision.uncertainty).toContain("The document list may change.");
  });

  it("parks an existing detected row for a canonical rejection", async () => {
    const p = packet();
    const decision = decide(p, model({
      readiness: "rejected",
      intervention: "maintain",
      change: null,
      targets: [],
      benefits: [],
      premise: {
        state: "contradicted",
        rationale: "The supplied page answers the claimed gap.",
        references: ["page:p1"],
      },
      coverage: [{
        pageId: "page:p1",
        state: "answers",
        rationale: "It answers the question.",
        excerpts: ["Our warranty covers repairs for twelve months."],
        limitations: [],
      }],
    }));
    const updates: Array<{ data: { status?: string; parkReason?: string } }> = [];
    const db = {
      opportunity: {
        findUnique: async () => ({ id: "op-1", status: "detected" }),
        update: async (args: { data: { status?: string; parkReason?: string } }) => {
          updates.push(args);
          return { id: "op-1" };
        },
      },
      evidenceEdge: { findMany: async () => [] },
    } as never;
    await publishDecision(db, { projectId: "p1", decision, findingType: "CONCERN", evidenceId: "e1" });
    expect(updates[0]?.data.status).toBe("parked");
    expect(updates[0]?.data.parkReason).toBe("decision_rejected");
  });

  it("carries the packet identity and policy into the decision", () => {
    const p = packet();
    const decision = decide(p, model());
    expect(decision.packetHash).toBe(p.packetHash);
    expect(decision.candidateId).toBe("f1");
    expect(decision.dedupKey).toBe("O13:warranty claim documents");
    expect(decision.policyVersion).toBe(p.policyVersion);
    expect(decision.promptVersion).toBe("recommendation-prompt/1");
  });
});
