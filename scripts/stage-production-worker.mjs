#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

export async function stageWorker({ source, releaseDir, sha }) {
  const actualSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha) || sha !== actualSha) throw new Error(`Worker source SHA mismatch: expected ${sha}, found ${actualSha}`);
  await readFile(path.join(source, "package.json"), "utf8");
  for (const item of ["scripts/job-worker.ts", "scripts/check-worker-release.mjs", "mcp/http-server.ts", "node_modules/.bin/tsx", "prisma/schema.prisma", "node_modules/.prisma/client/schema.prisma"]) {
    await lstat(path.join(source, item)).catch(() => { throw new Error(`Worker source is incomplete: ${item}`); });
  }
  await mkdir(path.dirname(releaseDir), { recursive: true });
  if (await lstat(releaseDir).catch(() => null)) throw new Error("Worker release path already exists");
  const tmp = `${releaseDir}.stage-${process.pid}`;
  await mkdir(tmp, { recursive: false });
  try {
    for (const item of ["scripts", "mcp", "lib", "prisma", "node_modules", "package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "next-env.d.ts"]) {
      if (await lstat(path.join(source, item)).catch(() => null)) await cp(path.join(source, item), path.join(tmp, item), { recursive: true, dereference: true });
    }
    await writeFile(path.join(tmp, "RELEASE_SHA"), `${sha}\n`, { flag: "wx" });
    await rename(tmp, releaseDir);
  } catch (error) { await rm(tmp, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [source, releaseDir, sha] = process.argv.slice(2);
  stageWorker({ source, releaseDir, sha }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
