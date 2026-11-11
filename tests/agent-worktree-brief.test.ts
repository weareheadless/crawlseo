import { describe, expect, it } from "vitest";

import { worktreeBrief } from "@/lib/agent-tasks/prompt";

/**
 * A run happens in a worktree, but the stored brief names the main checkout.
 * An agent that follows that path edits the shared repository, which is exactly
 * what one run did while its worktree stayed untouched.
 */
describe("worktree brief", () => {
  it("replaces the repository path with the worktree", () => {
    const brief = worktreeBrief("SITE: example.com\nREPOSITORY: /srv/site\nROUTE: /x", "/tmp/opencode/agent-1");
    expect(brief).toContain("REPOSITORY: /tmp/opencode/agent-1");
    expect(brief).not.toContain("REPOSITORY: /srv/site");
    expect(brief).toContain("WORKING COPY: /tmp/opencode/agent-1");
    expect(brief).toContain("never write to it");
  });

  it("leaves a brief without a repository line usable", () => {
    const brief = worktreeBrief("Do the thing.", "/tmp/opencode/agent-2");
    expect(brief).toContain("Do the thing.");
    expect(brief).toContain("WORKING COPY: /tmp/opencode/agent-2");
  });
});
