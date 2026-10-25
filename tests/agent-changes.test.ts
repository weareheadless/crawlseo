import { describe, expect, it } from "vitest";
import { agentChangeOutcome, isReleaseableSiteFile, parseGitStatusFiles } from "@/lib/agent-tasks/changes";

describe("agent changes", () => {
  it("parses tracked, untracked, and renamed files", () => {
    expect(parseGitStatusFiles([
      " M src/pages/Home.js",
      "?? scripts/remove-blog-hashtag-links.mjs",
      "?? scripts/test-blog-hashtag-links.mjs",
      'R  "src/pages/Old Name.js" -> "src/pages/New Name.js"',
    ].join("\n"))).toEqual([
      "src/pages/Home.js",
      "scripts/remove-blog-hashtag-links.mjs",
      "scripts/test-blog-hashtag-links.mjs",
      "src/pages/New Name.js",
    ]);
  });

  it("only treats page and public JS as releaseable site code", () => {
    expect(isReleaseableSiteFile("src/pages/Home.js")).toBe(true);
    expect(isReleaseableSiteFile("src/public/custom-elements/hero.js")).toBe(true);
    expect(isReleaseableSiteFile("scripts/test-blog-hashtag-links.mjs")).toBe(false);
    expect(isReleaseableSiteFile("wix.config.json")).toBe(false);
  });

  it("flags script-only changes as non-code changes", () => {
    expect(agentChangeOutcome([])).toBe("no_changes");
    expect(agentChangeOutcome(["scripts/remove-blog-hashtag-links.mjs"])).toBe("non_code_changes");
    expect(agentChangeOutcome(["scripts/remove-blog-hashtag-links.mjs", "src/pages/Home.js"])).toBe("changes_ready");
  });
});
