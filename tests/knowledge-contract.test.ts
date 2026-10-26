import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(readFileSync(resolve(process.cwd(), "contracts/business-knowledge-v1.schema.json"), "utf8"));
const fixtures: {
  valid: unknown[];
  invalid: unknown[];
  conflictCases: Array<{ name: string; state: object; credential: object; priorRequest?: object; request: object; response: { code: string; retryable: boolean } }>;
  acceptanceCases: Array<{ name: string; request: object; before: { revision: number; state: string; acceptedRevision: number | null }; after: { revision: number; state: string; acceptedRevision: number | null }; acceptedRead: { revision: number } }>;
  historicalReadCases: Array<{ state: { revision: number; acceptedRevision: number; acceptedRevisions: number[] }; read: { view: string; revision?: number }; result: { revision: number } }>;
  registrationCases: Array<{ name: string; bootstrapCredential: { externalOrganizationId: string; permissions: string[] }; serverAllowlist: string[]; request: any; result: any }>;
} = JSON.parse(readFileSync(resolve(process.cwd(), "examples/business-knowledge-v1-fixtures.json"), "utf8"));
const validate = new Ajv({ allErrors: true }).compile(schema);
const hasValidLifecyclePins = (fixture: any) => fixture.kind !== "business_document" || (
  fixture.acceptedRevision === null || fixture.acceptedRevision <= fixture.revision
) && (fixture.state !== "accepted" || fixture.acceptedRevision === fixture.revision);
const hasValidRegistrationIdentity = (fixture: any) => fixture.kind !== "project_registration" ||
  !fixture.origin || !fixture.externalProjectId || `${fixture.origin.system}:${fixture.origin.externalId}` === fixture.externalProjectId;

describe("shared business knowledge v1 producer/consumer fixtures", () => {
  it("accepts registration, provenance-bearing documents, CAS writes, reads and explicit errors", () => {
    for (const [index, fixture] of fixtures.valid.entries()) {
      expect(validate(fixture), `valid fixture ${index}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(hasValidLifecyclePins(fixture), `valid lifecycle fixture ${index}`).toBe(true);
      expect(hasValidRegistrationIdentity(fixture), `valid origin identity fixture ${index}`).toBe(true);
    }
  });

  it("rejects missing origin scope, weak retry identity, untyped fields and bad acceptance pins", () => {
    for (const [index, fixture] of fixtures.invalid.entries()) {
      const lifecycleOnlyInvalid = (fixture as any).kind === "business_document" && (fixture as any).acceptedRevision === 999;
      const registrationIdentityInvalid = (fixture as any).kind === "project_registration" && !hasValidRegistrationIdentity(fixture);
      if (lifecycleOnlyInvalid || registrationIdentityInvalid) {
        expect(validate(fixture), `schema permits semantic cross-field check ${index}`).toBe(true);
        if (lifecycleOnlyInvalid) expect(hasValidLifecyclePins(fixture)).toBe(false);
        if (registrationIdentityInvalid) expect(hasValidRegistrationIdentity(fixture)).toBe(false);
      } else {
        expect(validate(fixture), `invalid fixture ${index}`).toBe(false);
      }
    }
    const impossiblePin = fixtures.invalid.find((fixture: any) => fixture.kind === "business_document" && fixture.acceptedRevision === 999);
    expect(validate(impossiblePin)).toBe(true);
    expect(hasValidLifecyclePins(impossiblePin)).toBe(false);
  });

  it("specifies consumer outcomes from stored state, credentials and prior idempotent requests", () => {
    expect(fixtures.conflictCases.map(({ name }) => name)).toEqual([
      "stale-revision",
      "same-idempotency-key-different-body",
      "wrong-project-scope",
    ]);
    for (const { state, credential, priorRequest, request, response } of fixtures.conflictCases) {
      const stored = state as any;
      const auth = credential as any;
      const incoming = request as any;
      if (incoming.kind === "document_write" && stored.revision !== incoming.expectedRevision && !priorRequest) {
        expect(response.code).toBe("REVISION_CONFLICT");
      }
      if (priorRequest) {
        const prior = priorRequest as any;
        expect(prior.idempotencyKey).toBe(incoming.idempotencyKey);
        expect(prior).not.toEqual(incoming);
        expect(response.code).toBe("IDEMPOTENCY_CONFLICT");
      }
      if (incoming.projectId !== auth.projectId) {
        expect(response.code).toBe("NOT_FOUND");
      }
      expect(validate(request)).toBe(true);
      expect(validate(response)).toBe(true);
    }
    expect(fixtures.conflictCases.map(({ response }) => response.code)).toEqual([
      "REVISION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "NOT_FOUND",
    ]);
    expect(fixtures.conflictCases.map(({ response }) => response.retryable)).toEqual([true, false, false]);
  });

  it("pins acceptance to the exact current revision and reads that immutable accepted revision", () => {
    for (const fixture of fixtures.acceptanceCases) {
      expect(validate(fixture.request)).toBe(true);
      expect(fixture.after).toEqual({ revision: fixture.before.revision, state: "accepted", acceptedRevision: fixture.before.revision });
      expect(fixture.acceptedRead.revision).toBe(fixture.before.revision);
    }
    for (const fixture of fixtures.historicalReadCases) {
      expect(fixture.state.acceptedRevision).toBeLessThan(fixture.state.revision);
      expect(fixture.read.view).toBe("accepted");
      expect(fixture.read.revision).toBeLessThan(fixture.state.acceptedRevision);
      expect(fixture.state.acceptedRevisions).toContain(fixture.read.revision);
      expect(fixture.result.revision).toBe(fixture.read.revision);
    }
  });

  it("keeps business identity independent of an optional public domain", () => {
    const registration = fixtures.valid[0] as { domain?: unknown; origin: { system: string; externalId: string }; externalProjectId: string };
    expect(registration.domain).toBeNull();
    expect(registration.externalProjectId).toBe(`${registration.origin.system}:${registration.origin.externalId}`);
    expect(validate(registration)).toBe(true);
    expect(validate({ ...registration, domain: "northstar.example" })).toBe(true);
  });

  it("binds bootstrap credentials to the authenticated organization and treats requested permissions as advisory", () => {
    for (const fixture of fixtures.registrationCases) {
      expect(validate(fixture.request)).toBe(true);
      expect(validate(fixture.result)).toBe(true);
      if (fixture.bootstrapCredential.externalOrganizationId !== fixture.request.externalOrganizationId) {
        expect(fixture.result.code).toBe("FORBIDDEN");
        continue;
      }
      expect(fixture.bootstrapCredential.permissions).toEqual(["project:register"]);
      expect(fixture.result.credentialScope.externalOrganizationId).toBe(fixture.request.externalOrganizationId);
      expect(fixture.result.credentialScope.workspaceId).toBe(fixture.result.workspaceId);
      expect(fixture.result.credentialScope.projectId).toBe(fixture.result.projectId);
      expect(fixture.result.credentialScope.permissions).toEqual(["project:read", "document:read"]);
      expect(fixture.result.credentialScope.permissions).not.toContain("document:write");
    }
  });
});
