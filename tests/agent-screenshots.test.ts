import { describe, expect, it } from "vitest";
import { selectScreenshotUrls } from "@/lib/agent-tasks/screenshots";

describe("agent screenshots", () => {
  it("selects representative visual pages for an alt-text task", () => {
    expect(selectScreenshotUrls({
      route: "https://www.example.com/",
      evidence: {
        issue_type: "MISSING_ALT",
        urls: [
          "https://www.example.com/",
          "https://www.example.com/en/category/lamps",
          "https://www.example.com/en/category/lamps?page=2",
          "https://www.example.com/lampes/lampes-upcycling",
          "https://www.example.com/post/example",
        ],
      },
    })).toEqual([
      "https://www.example.com/",
      "https://www.example.com/en/category/lamps",
      "https://www.example.com/lampes/lampes-upcycling",
    ]);
  });

  it("does not capture screenshots for non-visual issues", () => {
    expect(selectScreenshotUrls({
      route: "https://www.example.com/",
      evidence: { issue_type: "MISSING_TITLE", urls: ["https://www.example.com/"] },
    })).toEqual([]);
  });
});
