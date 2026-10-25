import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, stage } from "../scripts/stage-production-web.mjs";

const repoRoot = path.resolve(__dirname, "..");
const startupScript = path.join(repoRoot, "scripts", "start-production.sh");
const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "crawlseo-release-test-"));
  tempRoots.push(root);
  return root;
}

async function makeBuild(root: string) {
  const source = path.join(root, "source");
  const buildDir = path.join(source, ".next");
  await mkdir(path.join(buildDir, "standalone", ".next"), { recursive: true });
  await mkdir(path.join(buildDir, "static"), { recursive: true });
  await mkdir(path.join(source, "public"), { recursive: true });
  await writeFile(path.join(buildDir, "BUILD_ID"), "build-123\n");
  await writeFile(path.join(buildDir, "standalone", ".next", "BUILD_ID"), "build-123\n");
  await writeFile(path.join(buildDir, "standalone", "server.js"), "// fake standalone server\n");
  await writeFile(path.join(buildDir, "standalone", ".env"), "BUILD_ONLY_SECRET=must-not-ship\n");
  await writeFile(path.join(buildDir, "standalone", ".env.production.local"), "BUILD_OVERRIDE=must-not-ship\n");
  await writeFile(path.join(buildDir, "static", "asset.txt"), "static asset\n");
  await writeFile(path.join(source, "public", "robots.txt"), "User-agent: *\n");
  const envFile = path.join(root, "runtime.env");
  await writeFile(envFile, "DATABASE_URL=secret-test-value\n");
  return { source, buildDir, envFile };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production web release slots", () => {
  it("stages a complete release and copies runtime env with restrictive permissions", async () => {
    const root = await tempRoot();
    const paths = await makeBuild(root);
    const releaseDir = path.join(root, "releases", "release-1");
    await stage({ ...paths, releaseDir });
    await expect(readFile(path.join(releaseDir, "server.js"), "utf8")).resolves.toContain("fake standalone");
    await expect(readFile(path.join(releaseDir, ".next", "BUILD_ID"), "utf8")).resolves.toBe("build-123\n");
    await expect(readFile(path.join(releaseDir, ".next", "static", "asset.txt"), "utf8")).resolves.toBe("static asset\n");
    await expect(readFile(path.join(releaseDir, "public", "robots.txt"), "utf8")).resolves.toContain("User-agent");
    await expect(readFile(path.join(releaseDir, ".env"), "utf8")).resolves.toBe("DATABASE_URL=secret-test-value\n");
    await expect(readFile(path.join(paths.buildDir, "standalone", ".env"), "utf8")).resolves.toContain("must-not-ship");
    expect((await stat(path.join(releaseDir, ".env"))).mode & 0o777).toBe(0o600);
    await expect(stat(path.join(releaseDir, ".env.production.local"))).rejects.toThrow();
  });

  it("rejects a standalone build from a different BUILD_ID", async () => {
    const root = await tempRoot();
    const paths = await makeBuild(root);
    await writeFile(path.join(paths.buildDir, "standalone", ".next", "BUILD_ID"), "other-build\n");

    await expect(stage({ ...paths, releaseDir: path.join(root, "releases", "release-1") }))
      .rejects.toThrow("does not match");
  });

  it("refuses an existing release path without changing its contents", async () => {
    const root = await tempRoot();
    const paths = await makeBuild(root);
    const releaseDir = path.join(root, "releases", "release-1");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "keep.txt"), "existing release\n");

    await expect(stage({ ...paths, releaseDir })).rejects.toThrow("refusing to overwrite");
    await expect(readFile(path.join(releaseDir, "keep.txt"), "utf8")).resolves.toBe("existing release\n");
    await expect(stat(path.join(releaseDir, "server.js"))).rejects.toThrow();
  });

  it("resolves a configured slot and execs its server without asset mutation", async () => {
    const startup = await readFile(startupScript, "utf8");
    const releaseBranch = startup.slice(0, startup.indexOf("# Backwards-compatible path"));

    expect(releaseBranch).toContain('readlink -f -- "$CRAWLSEO_WEB_RELEASE_DIR"');
    expect(releaseBranch).toContain('[[ ! -d "$release_dir" || ! -f "$release_dir/server.js" || ! -f "$release_dir/.next/BUILD_ID" ]]');
    expect(releaseBranch).toContain('cd "$release_dir"');
    expect(releaseBranch).toContain('exec node server.js');
    expect(releaseBranch).not.toMatch(/\b(rm|cp|mv)\b/);
    expect(startup).toContain("exec node .next/standalone/server.js");
  });

  it("requires explicit staging inputs", () => {
    expect(() => parseArgs([])).toThrow("Missing required option");
    expect(() => parseArgs(["--source", "/tmp/source"])).toThrow("Missing required option");
  });
});
