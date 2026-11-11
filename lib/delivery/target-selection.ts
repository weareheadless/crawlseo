import { classifyEditorialTarget } from "@/lib/editorial/targets";

export type EmbedTargetCandidate = {
  key: string;
  componentTag: string | null;
};

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

export function scoreEmbedTarget(
  target: EmbedTargetCandidate,
  action: { title?: string | null; targetUrl?: string | null },
): number {
  if (!target.componentTag) return 0;
  const tagTerms = target.componentTag
    .toLowerCase()
    .replace(/-v\d+$/, "")
    .split("-")
    .filter((term) => term.length > 2);
  const text = `${action.title ?? ""} ${action.targetUrl ?? ""}`.toLowerCase();
  let score = tagTerms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);

  const targetClass = classifyEditorialTarget(action.targetUrl).targetClass;
  const tag = target.componentTag.toLowerCase();
  if (targetClass === "category" && tag.includes("categor")) score += 4;
  if (targetClass === "product" && tag.includes("product")) score += 2;

  const path = (() => {
    try {
      return new URL(action.targetUrl ?? "").pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (path && tagTerms.some((term) => path.includes(term))) score += 1;
  return score;
}

export function selectEmbedTargetKey(
  targets: EmbedTargetCandidate[],
  action: { title?: string | null; targetUrl?: string | null },
): string | null {
  const scored = targets
    .map((target) => ({ target, score: scoreEmbedTarget(target, action) }))
    .sort((a, b) => b.score - a.score || a.target.key.localeCompare(b.target.key));
  if (scored.length === 0 || scored[0].score <= 0) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].target.key;
}

/**
 * The target a code release updates.
 *
 * An action title often names the page, not the component that renders it, so
 * a page rewrite that changes `unit-type-collection-split` scored zero against
 * every target and could not be released. The changed file is the fact: if the
 * task changed a target's source, that target is the one to update.
 */
export function selectReleaseTargetKey(
  targets: Array<EmbedTargetCandidate & { sourcePath?: string | null }>,
  action: { title?: string | null; targetUrl?: string | null },
  changedFiles: string[],
): string | null {
  const byName = selectEmbedTargetKey(targets, action);
  if (byName) return byName;
  const byFile = changedFiles
    .map((file) => targets.find((target) => target.sourcePath === file))
    .find((target) => Boolean(target));
  return byFile?.key ?? null;
}
