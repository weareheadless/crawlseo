import { describe, expect, it } from "vitest";
import { assertPreparationEvidenceSources, ConnectorError, sourceFileTarget } from "@/lib/connectors/service";

const now = Date.parse("2026-10-25T12:00:00.000Z");
const source = (id: string, ageDays: number, recencyDays = 90) => ({
  id, retrievedAt: new Date(now - ageDays * 86_400_000), run: { recencyDays },
});

describe("bounded source-file Action targets", () => {
  const input = {
    targetUrl: "https://example.com/robots.txt",
    identity: { kind: "source_file", path: "public/robots.txt" },
    canonicalOrigin: "https://example.com/",
    declaredCapabilities: ["site_metadata.robots"],
    sourceFiles: ["public/robots.txt"],
    requiredCapabilities: ["site_metadata.robots"],
  };

  it("allows only a connector-declared exact robots/sitemap source file", () => {
    expect(sourceFileTarget(input)).toBe("public/robots.txt");
  });

  it("requires exact file, capability and canonical route agreement", () => {
    expect(() => sourceFileTarget({ ...input, identity: { kind: "source_file", path: "src/app/api/route.ts" } }))
      .toThrow("allowlist");
    expect(() => sourceFileTarget({ ...input, sourceFiles: [] })).toThrow("exact source-file capability");
    expect(() => sourceFileTarget({ ...input, targetUrl: "https://other.example/robots.txt" })).toThrow("canonical robots/sitemap URL");
    expect(() => sourceFileTarget({ ...input, targetUrl: "https://example.com/robots.txt?mode=private" })).toThrow("canonical robots/sitemap URL");
    expect(() => sourceFileTarget({ ...input, requiredCapabilities: ["content.prepare"] })).toThrow("exact source-file capability");
  });
});

describe("Action preparation evidence freshness", () => {
  it("requires every cited source to resolve", () => {
    expect(() => assertPreparationEvidenceSources(["fresh", "missing"], [source("fresh", 1)], 90, now))
      .toThrow("no longer available");
  });

  it("rejects a stale source even when another cited source is fresh", () => {
    expect(() => assertPreparationEvidenceSources(["fresh", "stale"], [source("fresh", 1), source("stale", 20)], 10, now))
      .toThrow("stale");
  });

  it("rejects materially future retrieval times", () => {
    expect(() => assertPreparationEvidenceSources(["future"], [source("future", -1)], 90, now))
      .toThrow("future retrieval time");
  });

  it("accepts all linked sources within the stricter run and current-policy limits", () => {
    expect(() => assertPreparationEvidenceSources(["a", "b"], [source("a", 8, 90), source("b", 8, 20)], 30, now)).not.toThrow();
  });

  it("requires a nonempty source set", () => {
    expect(() => assertPreparationEvidenceSources([], [], 90, now)).toThrow(ConnectorError);
  });

  it("rejects duplicate IDs because they indicate malformed evidence links", () => {
    expect(() => assertPreparationEvidenceSources(["a", "a"], [source("a", 1)], 90, now)).toThrow(ConnectorError);
  });
});
