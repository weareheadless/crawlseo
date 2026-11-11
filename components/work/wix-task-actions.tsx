"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Loader2, Play, RefreshCw, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AGENT_RUN_REQUESTED_EVENT } from "@/lib/agent-tasks/run-event";

export function WixTaskActions({
  taskId,
  status,
  kind,
  route,
  publishedUrl,
  hasPage = false,
}: {
  taskId: string;
  status: string;
  kind: string;
  route: string | null;
  publishedUrl: string | null;
  hasPage?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [routeValue, setRouteValue] = useState(route ?? "");

  async function request(path: string, method: "PATCH" | "POST", body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `${label} failed`);
      if (path.endsWith("/run")) {
        window.dispatchEvent(new Event(AGENT_RUN_REQUESTED_EVENT));
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  const spinner = (label: string) => busy === label ? <Loader2 className="size-3 animate-spin" /> : null;
  const isArticle = kind === "wix_article";

  if (status === "PUBLISHED") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1 rounded-md bg-signal/10 px-2 py-1 text-[11px] font-medium text-signal">
          <Check className="size-3" /> Published
        </span>
        {publishedUrl && (
          <Link href={publishedUrl} target="_blank" rel="noreferrer noopener" className="text-xs text-primary underline underline-offset-2">
            View live
          </Link>
        )}
        <Button size="sm" variant="outline" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}`, "PATCH", { status: "CLOSED" }, "close")} disabled={busy !== null}>
          {spinner("close") ?? <Check className="size-3" />}
          Close
        </Button>
        {error && <span className="text-[11px] text-danger">{error}</span>}
      </div>
    );
  }

  if (status === "READY" || status === "CHANGES_REQUESTED") {
    if (isArticle) {
      return (
        <p className="text-[11px] text-muted-foreground">
          This article has no draft yet. Regenerate it from the action before publishing.
        </p>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}/run`, "POST", {}, "run")} disabled={busy !== null}>
          {spinner("run") ?? <Play className="size-3" />}
          Run agent
        </Button>
        {error && <span className="text-[11px] text-danger">{error}</span>}
      </div>
    );
  }

  if (status === "AWAITING_TARGET") {
    return (
      <div className="space-y-2">
        <Button size="sm" variant="outline" onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}/check-target`, "POST", {}, "check")} disabled={busy !== null}>
          {spinner("check") ?? <RefreshCw className="size-3" />}
          Check the page now
        </Button>
        <p className="text-[11px] text-muted-foreground">
          The worker checks again on its own. You do not need to keep this page open.
        </p>
        {error && <p className="text-[11px] text-danger">{error}</p>}
      </div>
    );
  }

  if (status === "FAILED") {
    if (!hasPage) {
      return (
        <div className="space-y-2">
          <Button
            size="sm"
            onClick={async () => {
              setBusy("retry");
              setError(null);
              try {
                const reset = await fetch(`/crawlseo/api/agent-tasks/${taskId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ status: "READY" }),
                });
                const resetBody = await reset.json().catch(() => ({}));
                if (!reset.ok) throw new Error(resetBody.error ?? "Could not reset the task");
                const run = await fetch(`/crawlseo/api/agent-tasks/${taskId}/run`, { method: "POST" });
                const runBody = await run.json().catch(() => ({}));
                if (!run.ok) throw new Error(runBody.error ?? "Could not start the agent");
                window.dispatchEvent(new Event(AGENT_RUN_REQUESTED_EVENT));
                router.refresh();
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "Could not start the agent");
              } finally {
                setBusy(null);
              }
            }}
            disabled={busy !== null}
          >
            {spinner("retry") ?? <Play className="size-3" />}
            Run agent again
          </Button>
          <p className="text-[11px] text-muted-foreground">
            The run produced no page, so there is nothing to review yet. Start it again.
          </p>
          {error && <p className="text-[11px] text-danger">{error}</p>}
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}`, "PATCH", { status: "AWAITING_REVIEW" }, "review")}
          disabled={busy !== null}
        >
          {spinner("review") ?? <RefreshCw className="size-3" />}
          Return to review
        </Button>
        <p className="text-[11px] text-muted-foreground">
          The reviewed page is kept. Returning to review lets you deliver it again without re-running the agent.
        </p>
        {error && <p className="text-[11px] text-danger">{error}</p>}
      </div>
    );
  }

  if (status === "AWAITING_REVIEW") {
    return (
      <div className="space-y-3">
        {!isArticle && (
          <label className="block max-w-sm">
            <span className="font-data text-[10px] uppercase tracking-wide text-muted-foreground">Page route</span>
            <div className="mt-1 flex gap-2">
              <input
                value={routeValue}
                onChange={(event) => setRouteValue(event.target.value)}
                placeholder="/playa-del-carmen-condos"
                className="h-8 w-full rounded-md border border-border bg-background px-2 font-data text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}`, "PATCH", { route: routeValue.trim() || null }, "route")}
                disabled={busy !== null || !routeValue.trim()}
              >
                {spinner("route") ?? <Check className="size-3" />}
                Save
              </Button>
            </div>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              The route is the Wix page you create. Delivery waits until that page answers.
            </span>
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}/deliver`, "POST", {}, "deliver")}
            disabled={busy !== null || (!isArticle && !route)}
          >
            {spinner("deliver") ?? <Rocket className="size-3" />}
            {isArticle ? "Approve & publish" : "Approve & deliver"}
          </Button>
          {!isArticle && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => request(`/crawlseo/api/agent-tasks/${taskId}`, "PATCH", { status: "CHANGES_REQUESTED" }, "changes")}
              disabled={busy !== null}
            >
              {spinner("changes") ?? <Check className="size-3" />}
              Request changes
            </Button>
          )}
        </div>
        {!isArticle && !route && (
          <p className="text-[11px] text-warning">Save the page route before delivering.</p>
        )}
        {error && <p className="text-[11px] text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <p className="text-[11px] text-muted-foreground">
      {status === "RUNNING" ? "The agent is running. This page updates as it reports progress." : `Status: ${status}`}
    </p>
  );
}
