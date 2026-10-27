#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export async function verifyWorkerRelease({ releaseDir, expectedSha, generatedClientDir = undefined }) {
  if (!releaseDir || !expectedSha || !/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error("Worker release requires a release directory and full expected SHA");
  const root = await realpath(releaseDir).catch(() => { throw new Error("Configured worker release does not resolve"); });
  const identity = (await readFile(path.join(root, "RELEASE_SHA"), "utf8")).trim();
  if (identity !== expectedSha) throw new Error(`Worker release SHA mismatch: expected ${expectedSha}, found ${identity || "missing"}`);
  for (const entry of ["scripts/job-worker.ts", "mcp/http-server.ts", "scripts/check-worker-release.mjs", "node_modules/.bin/tsx", "prisma/schema.prisma", "node_modules/.prisma/client/schema.prisma"]) {
    await readFile(path.join(root, entry)).catch(() => { throw new Error(`Worker release is incomplete: ${entry} is missing`); });
  }
  const schema = await readFile(path.join(root, "prisma/schema.prisma"));
  const generatedSchema = await readFile(path.join(generatedClientDir ?? path.join(root, "node_modules/.prisma/client"), "schema.prisma"));
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  if (digest(schema) !== digest(generatedSchema)) throw new Error("Worker Prisma client schema does not match migrated release schema; run npx prisma generate");
  return root;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  verifyWorkerRelease({ releaseDir: process.env.CRAWLSEO_WORKER_RELEASE_DIR, expectedSha: process.env.CRAWLSEO_WORKER_EXPECTED_SHA })
    .then((root) => process.stdout.write(`Verified CrawlSEO worker release ${process.env.CRAWLSEO_WORKER_EXPECTED_SHA} at ${root}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
