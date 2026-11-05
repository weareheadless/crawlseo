import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertShadowDatabaseUrl,
  assertShadowDestination,
  assertShadowOutputPath,
} from "@/lib/recommendation/shadow-destination";

describe("shadow destination validation", () => {
  const root = mkdtempSync(join(tmpdir(), "shadow-destination-"));

  it("accepts an absolute JSON path under the approved root", () => {
    expect(assertShadowOutputPath(join(root, "shadow.json"), { allowedRoot: root })).toBe(join(root, "shadow.json"));
  });

  it("refuses a relative path, a repository path and an unapproved root", () => {
    expect(() => assertShadowOutputPath("shadow.json", { allowedRoot: root })).toThrow(/absolute/);
    expect(() => assertShadowOutputPath(join(process.cwd(), "shadow.json"), { allowedRoot: root })).toThrow(
      /outside the repository/
    );
    expect(() => assertShadowOutputPath("/tmp/not-approved/shadow.json", { allowedRoot: root })).toThrow(
      /must be inside/
    );
  });

  it("refuses an existing file unless overwrite is explicit", () => {
    const path = join(root, "existing.json");
    writeFileSync(path, "{}");
    expect(() => assertShadowOutputPath(path, { allowedRoot: root })).toThrow(/already exists/);
    expect(assertShadowOutputPath(path, { allowedRoot: root, overwrite: true })).toBe(path);
  });

  it("requires a non-public disposable schema and refuses the application URL", () => {
    const disposable = "postgresql://user:pass@localhost:5432/db?schema=csv_validation";
    expect(assertShadowDatabaseUrl(disposable, { applicationUrl: "postgresql://user:pass@localhost:5432/db?schema=public" })).toBe(
      disposable
    );
    expect(() => assertShadowDatabaseUrl("postgresql://user:pass@localhost:5432/db", { applicationUrl: null })).toThrow(
      /explicit schema/
    );
    expect(() =>
      assertShadowDatabaseUrl("postgresql://user:pass@localhost:5432/db?schema=public", { applicationUrl: null })
    ).toThrow(/public schema/);
    expect(() => assertShadowDatabaseUrl(disposable, { applicationUrl: disposable })).toThrow(/application database/);
  });

  it("validates both destinations before any connection or write", () => {
    const approved = mkdtempSync(join("/tmp/opencode", "shadow-destination-"));
    const outPath = join(approved, "combined.json");
    const databaseUrl = "postgresql://user:pass@localhost:5432/db?schema=csv_validation";
    expect(assertShadowDestination({ outPath, databaseUrl })).toEqual({ outPath, databaseUrl });
  });
});
