#!/usr/bin/env node
/**
 * Run the Next standalone server on more than one core.
 *
 * Next's `server.js` binds the port and serves everything on a single event
 * loop, so a burst of navigations (a board page prefetches dozens of routes)
 * queues behind one render after another: twelve concurrent page requests that
 * cost 0.13 s alone each took 1.2-1.6 s. The box has six cores and the product
 * is a read-mostly UI, so the server runs one worker per configured core count
 * behind Node's cluster handle.
 *
 * Safe to multiply because nothing lives in process memory: sessions are rows
 * in Postgres, releases are read-only, and the app keeps no ISR or fetch cache
 * that two workers could disagree about.
 */
const cluster = require("node:cluster");
const path = require("node:path");

const workers = Math.max(1, Math.min(6, Number(process.env.CRAWLSEO_WEB_WORKERS || 2)));
let shuttingDown = false;

if (cluster.isPrimary) {
  for (let index = 0; index < workers; index += 1) cluster.fork();

  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) {
      // Stop the primary once its last worker is gone, so PM2's reload does
      // not have to wait for the kill timeout.
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    // A worker that dies takes its share of the traffic with it; replace it
    // rather than run degraded until the next release.
    console.error(`[crawlseo] worker ${worker.process.pid} exited (${signal ?? code}); restarting`);
    cluster.fork();
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const worker of Object.values(cluster.workers ?? {})) worker?.kill(signal);
      // A worker that will not stop must not keep a reload hanging.
      setTimeout(() => process.exit(0), 8_000).unref();
    });
  }

  console.log(`[crawlseo] serving with ${workers} workers`);
} else {
  require(path.join(process.cwd(), "server.js"));
}
