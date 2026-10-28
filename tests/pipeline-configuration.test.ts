import { describe, expect, it } from "vitest";
import { configurationOwners, configurationSectionFields, mergeConstraints } from "@/lib/pipeline/configuration";

describe("pipeline configuration ownership", () => {
  it("assigns each editable field to exactly one owner", () => {
    const fields = Object.values(configurationSectionFields).flat();
    expect(new Set(fields).size).toBe(fields.length);
    expect(configurationOwners.topics).toBe("business");
    expect(configurationOwners.providers).toBe("research");
    expect(configurationOwners.cadence).toBe("operations");
  });

  it("preserves unrelated constraint keys when mirroring section values", () => {
    expect(mergeConstraints({ custom: "keep", goals: ["old"] }, { goals: ["new"] }))
      .toEqual({ custom: "keep", goals: ["new"] });
  });
});
