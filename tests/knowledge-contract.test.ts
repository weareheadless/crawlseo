import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(readFileSync(resolve(process.cwd(), "contracts/business-knowledge-v1.schema.json"), "utf8"));
const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), "examples/business-knowledge-v1-fixtures.json"), "utf8"));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

describe("shared business knowledge v1 producer/consumer fixtures", () => {
  it("accepts registration, provenance-bearing documents, CAS writes, reads and explicit errors", () => {
    for (const [index, fixture] of fixtures.valid.entries()) {
      expect(validate(fixture), `valid fixture ${index}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("rejects missing origin scope, weak retry identity and unpinned accepted revisions", () => {
    for (const [index, fixture] of fixtures.invalid.entries()) {
      expect(validate(fixture), `invalid fixture ${index}`).toBe(false);
    }
  });

  it("keeps business identity independent of an optional public domain", () => {
    const registration = fixtures.valid[0];
    expect(registration.domain).toBeNull();
    expect(validate(registration)).toBe(true);
    expect(validate({ ...registration, domain: "northstar.example" })).toBe(true);
  });
});
