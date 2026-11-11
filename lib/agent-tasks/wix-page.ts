import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { JobKind } from "@prisma/client";
import { db } from "@/lib/db";
import { addAgentArtifact, addAgentMessage } from "@/lib/agent-tasks/chat";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { agentTimeouts } from "@/lib/agent-tasks/timeouts";
import { markActionVerified } from "@/lib/research/action-status";
import { markOpportunityTaskDelivered } from "@/lib/agent-tasks/opportunity-task";
import { ResearchServiceError } from "@/lib/research/service";
import { deliverWixPageHtml, probeWixRoute } from "@/lib/delivery/wix-page";
import { checkComponentPlacement, deliverWixPageComponent } from "@/lib/delivery/wix-early-packet";
import { disableBridgeEmbed } from "@/lib/bridge/client";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { enqueueJob } from "@/lib/jobs/queue";
import { buildWixPagePrompt, markerFor, pageProblems, MAX_PAGE_BYTES } from "@/lib/agent-tasks/wix-page-prompt";
import { designProfileForSite } from "@/lib/design/profile";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export type WixPageTaskInput = {
  actionId: string;
  operatorInstructions?: string;
  /**
   * The page route. A proposal for an existing page carries it; a new page has
   * none until a human chooses one, so it may be null here.
   */
  route?: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function routeFromTarget(targetUrl: string | null): string | null {
  if (!targetUrl) return null;
  try {
    const pathname = new URL(targetUrl).pathname;
    return pathname && pathname !== "/" ? pathname.replace(/\/+$/, "") : null;
  } catch {
    return targetUrl.startsWith("/") && targetUrl !== "/" ? targetUrl.replace(/\/+$/, "") : null;
  }
}

export async function createWixPageTaskForAction(input: WixPageTaskInput) {
  const action = await db.researchAction.findUnique({
    where: { id: input.actionId },
    include: {
      site: {
        select: {
          id: true,
          domain: true,
          connectorBinding: { select: { executor: true, status: true } },
          siteProfile: { select: { language: true, country: true, design: true } },
          siteDeliveryConfig: { select: { repoPath: true } },
        },
      },
      drafts: { orderBy: { createdAt: "desc" }, take: 1 },
      agentTasks: {
        where: { status: { notIn: ["CLOSED", "COMPLETED", "FAILED", "CANCELLED"] } },
        select: { id: true, kind: true },
      },
    },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);
  if (action.site.connectorBinding?.status === "ACTIVE" && action.site.connectorBinding.executor !== "crawlseo-agent") {
    throw new ResearchServiceError("This site is owned by another execution connector", 409);
  }
  if (action.format === "article" || action.kind === "article") {
    throw new ResearchServiceError(
      "This action is an article. Use the article lane, which publishes through Wix Blog.",
      409,
    );
  }
  const route = input.route?.trim() || routeFromTarget(action.targetUrl);
  if (action.agentTasks.length > 0) {
    throw new ResearchServiceError("An open agent task already exists for this action", 409);
  }

  // A page task does not generate a draft here. A page_update draft is a
  // diagnosis of an existing page, not page copy; when no draft exists the
  // agent writes from the recommendation and evidence.
  const draft = action.drafts[0] ?? null;

  const task = await db.agentTask.create({
    data: {
      siteId: action.siteId,
      actionId: action.id,
      actionRevision: action.revision,
      draftId: draft?.id ?? null,
      kind: "wix_page",
      title: action.title,
      goal: action.recommendation,
      prompt: "",
      repoPath: "",
      route,
      branch: null,
    },
  });

  const design = await designProfileForSite(action.site.id, action.site.siteDeliveryConfig?.repoPath ?? null);

  // The marker is the task id, so the prompt is written once the id exists.
  const prompt = buildWixPagePrompt({
    taskId: task.id,
    domain: action.site.domain,
    route: route ?? "(assigned before delivery)",
    language: action.site.siteProfile?.language ?? "en",
    country: action.site.siteProfile?.country ?? null,
    action: {
      title: action.title,
      recommendation: action.recommendation,
      primaryQuery: action.primaryQuery,
      kind: action.kind,
      evidence: action.evidence,
    },
    draft: draft
      ? {
          title: draft.title,
          metaTitle: draft.metaTitle,
          metaDescription: draft.metaDescription,
          markdown: draft.markdown,
        }
      : null,
    design: design
      ? {
          repoPath: design.repoPath ?? action.site.siteDeliveryConfig?.repoPath ?? null,
          palette: design.palette,
          fonts: design.fonts,
          notes: design.notes,
        }
      : action.site.siteDeliveryConfig?.repoPath
        ? { repoPath: action.site.siteDeliveryConfig.repoPath, palette: [], fonts: [], notes: "" }
        : null,
    liveUrl: `https://${action.site.domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}`,
    operatorInstructions: input.operatorInstructions,
  });
  return db.agentTask.update({ where: { id: task.id }, data: { prompt } });
}

type Progress = {
  stage: string;
  startedAt: string;
  updatedAt: string;
  lines: Array<{ at: string; message: string }>;
};

async function flushProgress(taskId: string, progress: Progress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { result: true } });
  if (!task) return;
  await db.agentTask.update({
    where: { id: taskId },
    data: {
      result: {
        ...record(task.result),
        progress: { ...progress, lines: progress.lines.slice(-60) },
      } as never,
    },
  });
}

async function runAgent(command: string[], cwd: string, onOutput: (line: string) => void): Promise<string> {
  const timeouts = agentTimeouts({ batch: false });
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME,
        NODE_ENV: process.env.NODE_ENV,
        LANG: process.env.LANG ?? "C.UTF-8",
        TERM: process.env.TERM ?? "dumb",
        TMPDIR: "/tmp/opencode",
      },
    });
    let output = "";
    let buffer = "";
    let stderr = "";
    let finished = false;
    let inactivity: ReturnType<typeof setTimeout> | null = null;
    let maximum: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (inactivity) clearTimeout(inactivity);
      if (maximum) clearTimeout(maximum);
      inactivity = null;
      maximum = null;
    };
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clear();
      fn();
    };
    const reset = () => {
      if (finished) return;
      if (inactivity) clearTimeout(inactivity);
      inactivity = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`Agent produced no output for ${Math.round(timeouts.inactivityMs / 60_000)} minutes`)));
      }, timeouts.inactivityMs);
    };
    reset();
    maximum = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`Agent exceeded ${Math.round(timeouts.maxRuntimeMs / 60_000)} minutes`)));
    }, timeouts.maxRuntimeMs);
    child.once("error", (error) => finish(() => reject(error)));
    child.stdout?.on("data", (chunk: Buffer) => {
      reset();
      const text = chunk.toString("utf8");
      output = (output + text).slice(-1_000_000);
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { type?: string; part?: { text?: string; tool?: string; name?: string } };
          if (event.type === "text" && event.part?.text?.trim()) onOutput(event.part.text.trim().slice(0, 220));
          const tool = event.part?.tool ?? event.part?.name;
          if (tool && event.type === "tool_use") onOutput(`Tool: ${tool}`);
        } catch {
          // Non-JSON progress lines are not user-facing text.
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      reset();
      stderr = (stderr + chunk.toString("utf8")).slice(-100_000);
    });
    child.once("close", (code) => finish(() => {
      if (code === 0) resolve(output);
      else reject(new Error(`Agent exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`));
    }));
  });
}

export async function runWixPageTask(taskId: string) {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    include: {
      action: { select: { title: true, recommendation: true, evidence: true, primaryQuery: true, kind: true } },
      site: { select: { domain: true, siteProfile: { select: { language: true, country: true } } } },
      draft: { select: { title: true, metaTitle: true, metaDescription: true, markdown: true } },
      messages: { where: { role: "HUMAN" }, orderBy: { createdAt: "asc" }, take: 20 },
    },
  });
  if (!task) throw new Error("Agent task not found");
  if (task.kind !== "wix_page") throw new Error(`Task ${task.id} is not a Wix page task`);
  if (!["READY", "CHANGES_REQUESTED"].includes(task.status)) {
    throw new Error(`Agent task is ${task.status}; only READY or CHANGES_REQUESTED tasks can run`);
  }

  const directory = path.join("/tmp/opencode", `wix-page-${task.id}`);
  await mkdir(directory, { recursive: true });
  const followUps = task.messages
    .map((message) => message.content.trim())
    .filter((content) => content && !/^(go|ok|okay|yes|yep|do it|proceed)$/i.test(content))
    .slice(-10);
  const prompt = followUps.length > 0
    ? `${task.prompt}\n\nLATEST OPERATOR FOLLOW-UP\n${followUps.map((message) => `- ${message}`).join("\n")}`
    : task.prompt;

  const progress: Progress = {
    stage: "Starting agent",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lines: [{ at: new Date().toISOString(), message: `Workspace: ${directory}` }],
  };
  await db.agentTask.update({
    where: { id: task.id },
    data: { status: "RUNNING", worktreePath: directory, startedAt: new Date(), errorCode: null },
  });
  await flushProgress(task.id, progress);

  let lastFlush = 0;
  const onOutput = (message: string) => {
    if (progress.lines.at(-1)?.message === message) return;
    progress.lines.push({ at: new Date().toISOString(), message });
    const now = Date.now();
    if (now - lastFlush > 1_500) {
      lastFlush = now;
      void flushProgress(task.id, progress).catch(() => undefined);
    }
  };

  try {
    const output = await runAgent([
      "opencode",
      "run",
      "--agent", "build",
      "--model", process.env.OPENCODE_AGENT_MODEL?.trim() || "openrouter/deepseek/deepseek-v4.1-flash-1017",
      "--format", "json",
      "--auto",
      "--title", `CrawlSEO page ${task.id}`,
      prompt,
    ], directory, onOutput);

    const html = await readFile(path.join(directory, "page.html"), "utf8").catch(() => "");
    const designNotes = await readFile(path.join(directory, "design-notes.md"), "utf8").catch(() => "");
    if (designNotes.trim()) {
      await addAgentArtifact(task.id, { kind: "design_notes", content: designNotes.slice(0, 20_000) });
    }
    const navigation = await readFile(path.join(directory, "navigation.md"), "utf8").catch(() => "");
    if (navigation.trim()) {
      await addAgentArtifact(task.id, { kind: "navigation_notes", content: navigation.slice(0, 20_000) });
    }
    const problems = pageProblems(html, task.id);
    if (problems.length > 0) {
      await addAgentMessage(task.id, `The page was not deliverable:\n- ${problems.join("\n- ")}`, "SYSTEM");
      return db.agentTask.update({
        where: { id: task.id },
        data: {
          status: "CHANGES_REQUESTED",
          errorCode: "PAGE_HTML_INVALID",
          result: {
            ...record(task.result),
            progress: { ...progress, stage: "Page rejected" },
            pageProblems: problems,
          } as never,
        },
      });
    }

    const bytes = Buffer.byteLength(html, "utf8");
    await addAgentArtifact(task.id, { kind: "page_html", content: html, maxChars: MAX_PAGE_BYTES });
    await addAgentMessage(
      task.id,
      `Page prepared for ${task.route}: ${Math.round(bytes / 1024)} KB. Review it, then approve to deliver.`,
      "AGENT",
    );
    progress.stage = "Review ready";
    return db.agentTask.update({
      where: { id: task.id },
      data: {
        status: "AWAITING_REVIEW",
        errorCode: null,
        result: {
          ...record(task.result),
          progress: { ...progress, stage: "Review ready" },
          pageHtmlSha256: sha256(html),
          pageBytes: bytes,
          agentSummary: output.slice(-20_000),
        } as never,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed";
    await flushProgress(task.id, { ...progress, stage: "Failed" }).catch(() => undefined);
    await addAgentMessage(task.id, `Agent run failed: ${message.slice(0, 1_000)}`, "SYSTEM").catch(() => undefined);
    await db.agentTask.update({
      where: { id: task.id },
      data: { status: "FAILED", errorCode: message.slice(0, 120), completedAt: new Date() },
    });
    throw error;
  }
}

async function latestPageHtml(taskId: string): Promise<string> {
  const artifact = await db.agentTaskArtifact.findFirst({
    where: { taskId, kind: "page_html" },
    orderBy: { createdAt: "desc" },
    select: { content: true },
  });
  if (!artifact?.content) throw new ResearchServiceError("The page HTML is missing; run the agent again", 409);
  return artifact.content;
}

async function deliver(task: {
  id: string;
  siteId: string;
  actionId: string | null;
  draftId: string | null;
  route: string | null;
}, confirmedBy: string | null = null) {
  if (!task.route) throw new ResearchServiceError("The task has no page route", 409);
  const html = await latestPageHtml(task.id);
  const marker = markerFor(task.id);
  const before = await db.agentTask.findUnique({ where: { id: task.id }, select: { result: true } });
  const priorResult = record(before?.result);
  await updateAgentTask(task.id, { status: "PUBLISHING" });
  try {
    // A site with a connected source repository delivers the page as a custom
    // element registered by an early packet, which is how its other pages are
    // built. Without a repository the page is an HTML embed.
    const config = await getSiteDeliveryConfig(task.siteId);
    if (config?.repoPath) {
      const component = await deliverWixPageComponent({
        siteId: task.siteId,
        route: task.route,
        html,
        taskId: task.id,
      });
      const live = component.placement === "found";
      if (live) {
        if (task.actionId) await markActionVerified(task.actionId).catch(() => undefined);
        await markOpportunityTaskDelivered(task.id, confirmedBy).catch(() => undefined);
      }
      return updateAgentTask(task.id, {
        status: live ? "PUBLISHED" : "AWAITING_TARGET",
        publishedUrl: live ? component.url : null,
        result: {
          ...priorResult,
          delivery: { mode: "component", ...component },
          awaitingPlacement: live
            ? undefined
            : {
                tag: component.tag,
                url: component.url,
                route: component.route,
                attempts: 0,
                instruction: `Place <${component.tag}> on the Wix page at ${component.route}. The packet is already deployed, so the page renders as soon as the element is on it.`,
              },
          progress: {
            stage: live ? "Published" : "Waiting for the element placement",
            updatedAt: new Date().toISOString(),
          },
        } as never,
      });
    }

    const result = await deliverWixPageHtml({
      siteId: task.siteId,
      route: task.route,
      html,
      marker,
      taskId: task.id,
    });
    if (result.readback !== "match") {
      throw new ResearchServiceError("The embed readback does not match the approved page; Wix may still be propagating", 502);
    }
    // The hash readback is the hard verification: Wix accepted exactly these
    // bytes. The live DOM check is best effort because the embed mounts after
    // the page loads; a miss is reported, not turned into a false failure.
    const liveVerified = result.live.marker === "found";
    if (!task.actionId) throw new ResearchServiceError("A delivered page must belong to a research action", 409);
    try {
      await db.delivery.create({
        data: {
          actionId: task.actionId,
          draftId: task.draftId,
          platform: "wix_embed",
          externalId: result.snippetId,
          status: "PUBLISHED",
          verifiedAt: new Date(),
          payload: {
            target_key: result.targetKey,
            url: result.url,
            created: result.created,
            html_sha256: result.htmlSha256,
            readback: result.readback,
            live_http_status: result.live.httpStatus,
            live_marker: result.live.marker,
          } as never,
        },
      });
    } catch (error) {
      // The embed is already written. Losing the receipt row must not turn a
      // successful publish into a failure; it is recorded on the task instead.
      console.error("Wix page delivery receipt could not be stored:", error);
    }
    await markActionVerified(task.actionId).catch(() => undefined);
    await markOpportunityTaskDelivered(task.id, confirmedBy).catch(() => undefined);
    return updateAgentTask(task.id, {
      status: "PUBLISHED",
      publishedUrl: result.url,
      bridgeReceiptId: result.snippetId,
      result: {
        ...priorResult,
        delivery: result,
        liveVerified,
        progress: { stage: "Published", updatedAt: new Date().toISOString() },
      } as never,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delivery failed";
    await updateAgentTask(task.id, {
      status: "FAILED",
      errorCode: message.slice(0, 120),
      result: { ...priorResult, deliveryError: message.slice(0, 1_000) } as never,
    });
    throw error;
  }
}

/**
 * Approve the reviewed page and deliver it. The route is probed first: a
 * missing Wix page parks the task in AWAITING_TARGET, and the worker resumes
 * when the human has created it. No second click is required.
 */
export async function approveAndDeliverWixPage(taskId: string, confirmedBy: string | null = null) {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, siteId: true, actionId: true, draftId: true, route: true, status: true, kind: true, title: true, result: true },
  });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  if (task.kind !== "wix_page") throw new ResearchServiceError("This task is not a Wix page task", 409);
  if (task.status !== "AWAITING_REVIEW") {
    throw new ResearchServiceError(`Approve a task in AWAITING_REVIEW, not ${task.status}`, 409);
  }
  if (!task.route) {
    throw new ResearchServiceError("Set the page route before delivery; the human creates the Wix page at that route", 409);
  }

  const site = await db.site.findUnique({ where: { id: task.siteId }, select: { domain: true } });
  if (!site) throw new ResearchServiceError("Site not found", 404);
  const url = `https://${site.domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}${task.route}`;

  await updateAgentTask(task.id, { status: "APPROVED" });
  const httpStatus = await probeWixRoute(url);
  if (httpStatus !== 200) {
    await updateAgentTask(task.id, {
      status: "AWAITING_TARGET",
      result: {
        ...record(task.result),
        awaitingTarget: {
          route: task.route,
          url,
          httpStatus,
          attempts: 0,
          instruction: `Create and publish a blank page at ${task.route} in the Wix editor. The agent delivers the content as soon as the page answers.`,
        },
        progress: { stage: "Waiting for the page", updatedAt: new Date().toISOString() },
      } as never,
    });
    await enqueueJob({
      siteId: task.siteId,
      kind: JobKind.WIX_DELIVERY,
      payload: { agentTaskId: task.id },
      idempotencyKey: `wix-delivery:${task.id}:${Date.now()}`,
      maxAttempts: 1,
      delaySeconds: 15 * 60,
    });
    return { status: "awaiting_target" as const, route: task.route, url, httpStatus };
  }

  const published = await deliver(task, confirmedBy);
  return { status: "published" as const, task: published };
}

/** The worker calls this after the route probe delay. */
export async function resumeWixPageDelivery(taskId: string) {
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, siteId: true, actionId: true, draftId: true, route: true, status: true, kind: true, result: true },
  });
  if (!task) throw new ResearchServiceError("Agent task not found", 404);
  if (task.kind !== "wix_page") return { status: "skipped" as const };
  if (task.status !== "AWAITING_TARGET") return { status: "skipped" as const };
  if (!task.route) throw new ResearchServiceError("The task has no page route", 409);
  const site = await db.site.findUnique({ where: { id: task.siteId }, select: { domain: true } });
  if (!site) throw new ResearchServiceError("Site not found", 404);
  const url = `https://${site.domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}${task.route}`;
  const result = record(task.result);
  const delivery = record(result.delivery);

  // A component delivery is already deployed; only the human's element
  // placement is missing. Re-deploying the packet every probe would rewrite
  // the same bytes, so this path only checks the live document.
  if (delivery.mode === "component" && typeof delivery.tag === "string") {
    const placement = await checkComponentPlacement(url, delivery.tag);
    if (placement === "found") {
      // The page now renders from the placed element. An embed delivered
      // earlier replaces the page container and would hide it, so it is
      // disabled once the element is confirmed on the page.
      const config = await getSiteDeliveryConfig(task.siteId);
      const target = await db.deliveryTarget.findUnique({
        where: { siteId_key: { siteId: task.siteId, key: `page:${task.route}` } },
        select: { snippetId: true },
      });
      if (config?.bridgeAlias && target?.snippetId) {
        await disableBridgeEmbed(config.bridgeAlias, target.snippetId, true).catch(() => undefined);
      }
      if (task.actionId) await markActionVerified(task.actionId).catch(() => undefined);
      await markOpportunityTaskDelivered(task.id, null).catch(() => undefined);
      return {
        status: "published" as const,
        task: await updateAgentTask(task.id, {
          status: "PUBLISHED",
          publishedUrl: url,
          result: {
            ...result,
            delivery: { ...delivery, placement },
            awaitingPlacement: undefined,
            progress: { stage: "Published", updatedAt: new Date().toISOString() },
          } as never,
        }),
      };
    }
    const awaiting = record(result.awaitingPlacement);
    const attempts = typeof awaiting.attempts === "number" ? awaiting.attempts : 0;
    if (attempts >= 96) {
      await updateAgentTask(task.id, {
        result: {
          ...result,
          awaitingPlacement: { ...awaiting, attempts, parked: true, checkedAt: new Date().toISOString() },
        } as never,
      });
      return { status: "parked" as const, httpStatus: 200 };
    }
    await updateAgentTask(task.id, {
      result: {
        ...result,
        awaitingPlacement: { ...awaiting, attempts: attempts + 1, checkedAt: new Date().toISOString() },
      } as never,
    });
    await enqueueJob({
      siteId: task.siteId,
      kind: JobKind.WIX_DELIVERY,
      payload: { agentTaskId: task.id },
      idempotencyKey: `wix-delivery:${task.id}:${Date.now()}`,
      maxAttempts: 1,
      delaySeconds: 15 * 60,
    });
    return { status: "waiting" as const, httpStatus: 200 };
  }

  const httpStatus = await probeWixRoute(url);
  const awaiting = record(result.awaitingTarget);
  const attempts = typeof awaiting.attempts === "number" ? awaiting.attempts : 0;
  if (httpStatus !== 200) {
    // A day of probes is enough to carry a human through creating the page.
    // After that the task parks and the UI's check button resumes it, so the
    // queue does not grow a retry job forever.
    if (attempts >= 96) {
      await updateAgentTask(task.id, {
        result: {
          ...result,
          awaitingTarget: { ...awaiting, attempts, parked: true, checkedAt: new Date().toISOString() },
        } as never,
      });
      return { status: "parked" as const, httpStatus };
    }
    await updateAgentTask(task.id, {
      result: {
        ...result,
        awaitingTarget: { ...awaiting, attempts: attempts + 1, checkedAt: new Date().toISOString() },
      } as never,
    });
    await enqueueJob({
      siteId: task.siteId,
      kind: JobKind.WIX_DELIVERY,
      payload: { agentTaskId: task.id },
      idempotencyKey: `wix-delivery:${task.id}:${Date.now()}`,
      maxAttempts: 1,
      delaySeconds: 15 * 60,
    });
    return { status: "waiting" as const, httpStatus };
  }
  const published = await deliver(task);
  return { status: "published" as const, task: published };
}
