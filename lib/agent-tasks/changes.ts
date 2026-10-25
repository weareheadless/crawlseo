export type AgentChangeOutcome = "changes_ready" | "non_code_changes" | "no_changes";

export function parseGitStatusFiles(status: string): string[] {
  const files: string[] = [];
  for (const raw of status.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const withoutStatus = line.replace(/^[A-Z?]{1,2}\s+/, "").replace(/^"|"$/g, "");
    if (!withoutStatus) continue;
    const renameTarget = withoutStatus.includes(" -> ")
      ? withoutStatus.split(" -> ").pop()?.trim()
      : null;
    const file = (renameTarget || withoutStatus).replace(/^"|"$/g, "");
    if (file) files.push(file);
  }
  return [...new Set(files)];
}

export function isReleaseableSiteFile(file: string): boolean {
  return /^src\/pages\/[^/]+\.js$/i.test(file)
    || /^src\/public\/(?:[^/]+|custom-elements\/[^/]+)\.js$/i.test(file);
}

export function agentChangeOutcome(files: string[]): AgentChangeOutcome {
  if (files.length === 0) return "no_changes";
  return files.some(isReleaseableSiteFile) ? "changes_ready" : "non_code_changes";
}
