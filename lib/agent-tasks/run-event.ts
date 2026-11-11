/**
 * Fired when a run has been queued.
 *
 * The action bar and the run console are separate client components under a
 * server page. The event lets the console start reporting immediately, instead
 * of showing nothing until the worker flips the task to RUNNING.
 */
export const AGENT_RUN_REQUESTED_EVENT = "crawlseo:agent-run-requested";
