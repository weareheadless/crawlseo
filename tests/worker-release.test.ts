import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyWorkerRelease } from "../scripts/check-worker-release.mjs";
import { stage } from "../scripts/stage-production-web.mjs";
import { stageWorker } from "../scripts/stage-production-worker.mjs";

const sha = "a".repeat(40);
let temp: string;
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); });

describe("worker release guard", () => {
  it("rejects the wrong expected SHA and stale generated Prisma client", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "crawlseo-worker-release-"));
    const root = path.join(temp, "release");
    for (const name of ["scripts", "mcp", "node_modules/.bin", "node_modules/.prisma/client", "prisma"]) await mkdir(path.join(root, name), { recursive: true });
    for (const name of ["scripts/job-worker.ts", "mcp/http-server.ts", "scripts/check-worker-release.mjs", "node_modules/.bin/tsx"]) await writeFile(path.join(root, name), "fixture");
    await writeFile(path.join(root, "RELEASE_SHA"), `${sha}\n`);
    await writeFile(path.join(root, "prisma/schema.prisma"), "model Job { siteId String? }");
    await writeFile(path.join(root, "node_modules/.prisma/client/schema.prisma"), "model Job { siteId String }");
    await expect(verifyWorkerRelease({ releaseDir: root, expectedSha: "b".repeat(40) })).rejects.toThrow("SHA mismatch");
    await expect(verifyWorkerRelease({ releaseDir: root, expectedSha: sha })).rejects.toThrow("does not match");
  });

  it("stages runtime code under the exact source SHA without changing web stage", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "crawlseo-worker-stage-"));
    const source = path.join(temp, "source");
    const release = path.join(temp, "releases", sha);
    await mkdir(source, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", source]);
    await mkdir(path.join(source, "scripts"), { recursive: true });
    await mkdir(path.join(source, "mcp"), { recursive: true });
    await mkdir(path.join(source, "lib"), { recursive: true });
    await mkdir(path.join(source, "prisma"), { recursive: true });
    await mkdir(path.join(source, "node_modules/.bin"), { recursive: true });
    await mkdir(path.join(source, "node_modules/.prisma/client"), { recursive: true });
    for (const item of ["scripts/job-worker.ts", "scripts/check-worker-release.mjs", "mcp/http-server.ts", "node_modules/.bin/tsx", "prisma/schema.prisma", "node_modules/.prisma/client/schema.prisma"]) await writeFile(path.join(source, item), "fixture");
    await writeFile(path.join(source, "package.json"), "{}");
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);
    const actualSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await stageWorker({ source, releaseDir: release, sha: actualSha });
    expect((await readFile(path.join(release, "RELEASE_SHA"), "utf8")).trim()).toBe(actualSha);
    await expect(stageWorker({ source, releaseDir: path.join(temp, "bad"), sha })).rejects.toThrow("SHA mismatch");
  });

  it("keeps web release staging functional", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "crawlseo-web-stage-"));
    const build = path.join(temp, "build");
    const source = path.join(temp, "source");
    const output = path.join(temp, "release");
    for (const name of ["standalone/.next", "static"]) await mkdir(path.join(build, name), { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(build, "BUILD_ID"), "id\n");
    await writeFile(path.join(build, "standalone/server.js"), "server");
    await writeFile(path.join(build, "standalone/.next/BUILD_ID"), "id\n");
    await writeFile(path.join(build, "static/asset.js"), "asset");
    await mkdir(path.join(source, "public"));
    await writeFile(path.join(source, "public/index.html"), "ok");
    const env = path.join(temp, "env"); await writeFile(env, "SECRET=value\n");
    await stage({ source, buildDir: build, releaseDir: output, envFile: env });
    expect(await readFile(path.join(output, "server.js"), "utf8")).toBe("server");
  });
});
