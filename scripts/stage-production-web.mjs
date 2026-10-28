#!/usr/bin/env node
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  return [
    "Usage: node scripts/stage-production-web.mjs --source DIR --build-dir DIR --release-dir DIR --env-file FILE",
    "  --source      Isolated source checkout containing public/",
    "  --build-dir   Completed Next build directory (the .next directory)",
    "  --release-dir New final release path; an existing path is never replaced",
    "  --env-file    Runtime env file copied to the release as .env with mode 0600",
  ].join("\n");
}

export function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--source", "--build-dir", "--release-dir", "--env-file"].includes(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of ["--source", "--build-dir", "--release-dir", "--env-file"]) {
    if (!values.has(flag)) throw new Error(`Missing required option: ${flag}`);
  }
  return {
    source: path.resolve(values.get("--source")),
    buildDir: path.resolve(values.get("--build-dir")),
    releaseDir: path.resolve(values.get("--release-dir")),
    envFile: path.resolve(values.get("--env-file")),
  };
}

/**
 * Standalone output may contain symlinks into the build checkout. A release must
 * survive deletion of that checkout, so replace every symlink with a real copy.
 */
export async function dereferenceTree(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(target);
      const resolvedInfo = await stat(resolved);
      await rm(target, { recursive: true, force: true });
      await cp(resolved, target, { recursive: resolvedInfo.isDirectory(), force: true });
      if (resolvedInfo.isDirectory()) await dereferenceTree(target);
    } else if (info.isDirectory()) {
      await dereferenceTree(target);
    }
  }
}

async function requireFile(file, label) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`${label} is missing or is not a file`);
}

export async function stage({ source, buildDir, releaseDir, envFile }) {
  const standaloneDir = path.join(buildDir, "standalone");
  const standaloneNextDir = path.join(standaloneDir, ".next");
  const standaloneServer = path.join(standaloneDir, "server.js");
  const standaloneBuildId = path.join(standaloneNextDir, "BUILD_ID");
  const staticDir = path.join(buildDir, "static");
  const publicDir = path.join(source, "public");

  await Promise.all([
    requireFile(standaloneServer, "Standalone server"),
    requireFile(standaloneBuildId, "Standalone build ID"),
    requireFile(path.join(buildDir, "BUILD_ID"), "Build ID"),
    requireFile(envFile, "Runtime env file"),
  ]);
  const staticInfo = await stat(staticDir).catch(() => null);
  if (!staticInfo?.isDirectory()) throw new Error("Build static directory is missing");
  const publicInfo = await stat(publicDir).catch(() => null);
  if (!publicInfo?.isDirectory()) throw new Error("Source public directory is missing");
  const [buildIdContents, standaloneBuildIdContents] = await Promise.all([
    readFile(path.join(buildDir, "BUILD_ID"), "utf8"),
    readFile(standaloneBuildId, "utf8"),
  ]);
  if (buildIdContents.trim() !== standaloneBuildIdContents.trim()) {
    throw new Error("Standalone build ID does not match the source build");
  }

  const releaseParent = path.dirname(releaseDir);
  await mkdir(releaseParent, { recursive: true });
  const existing = await lstat(releaseDir).catch(() => null);
  if (existing) throw new Error("Release path already exists; refusing to overwrite it");

  const tempDir = await mkdtemp(path.join(releaseParent, `.${path.basename(releaseDir)}.stage-`));
  try {
    await rm(tempDir, { recursive: true });
    await cp(standaloneDir, tempDir, { recursive: true, force: false, errorOnExist: true });
    await mkdir(path.join(tempDir, ".next"), { recursive: true });
    await dereferenceTree(path.join(tempDir, ".next", "node_modules"));
    await rm(path.join(tempDir, ".next", "static"), { recursive: true, force: true });
    await cp(staticDir, path.join(tempDir, ".next", "static"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await rm(path.join(tempDir, "public"), { recursive: true, force: true });
    await cp(publicDir, path.join(tempDir, "public"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });

    const envPath = path.join(tempDir, ".env");
    // Next standalone output may include a traced build-time .env. Replace it
    // only in the new staging directory with the explicitly supplied runtime
    // env file; never touch the source build or an existing release.
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
      await rm(path.join(tempDir, name), { force: true });
    }
    const envHandle = await open(envPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await envHandle.close();
      await copyFile(envFile, envPath);
      await chmod(envPath, 0o600);
    } catch (error) {
      await envHandle.close().catch(() => undefined);
      throw error;
    }

    await Promise.all([
      requireFile(path.join(tempDir, "server.js"), "Staged standalone server"),
      requireFile(path.join(tempDir, ".next", "BUILD_ID"), "Staged build ID"),
    ]);
    const stagedStatic = await stat(path.join(tempDir, ".next", "static")).catch(() => null);
    const stagedPublic = await stat(path.join(tempDir, "public")).catch(() => null);
    if (!stagedStatic?.isDirectory() || !stagedPublic?.isDirectory()) {
      throw new Error("Staged static or public assets are incomplete");
    }

    // Check again immediately before promotion. rename() also refuses to
    // replace a non-empty directory, protecting an existing release slot.
    if (await lstat(releaseDir).catch(() => null)) {
      throw new Error("Release path appeared during staging; refusing to overwrite it");
    }
    await rename(tempDir, releaseDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  try {
    const paths = parseArgs(process.argv.slice(2));
    await stage(paths);
    process.stdout.write(`Staged web release ${path.basename(paths.releaseDir)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Release staging failed"}\n${usage()}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
