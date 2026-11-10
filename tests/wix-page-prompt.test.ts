import { describe, expect, it } from "vitest";
import { buildWixPagePrompt, markerFor, pageProblems } from "@/lib/agent-tasks/wix-page-prompt";

const input = {
  taskId: "task-123",
  domain: "example.com",
  route: "/condos",
  language: "fr",
  country: "FR",
  action: {
    title: "Page condos",
    recommendation: "Build the page",
    primaryQuery: "condos à vendre",
    kind: "update",
    evidence: { impressions: 10 },
  },
  draft: {
    title: "Condos",
    metaTitle: "Condos à vendre",
    metaDescription: "Trouvez un condo",
    markdown: "## Pourquoi\n\nUn paragraphe.",
  },
};

describe("Wix page prompt", () => {
  it("carries the task marker, route, language and draft", () => {
    const prompt = buildWixPagePrompt(input);
    expect(prompt).toContain(markerFor("task-123"));
    expect(prompt).toContain("PAGE ROUTE: /condos");
    expect(prompt).toContain("LANGUAGE: fr");
    expect(prompt).toContain("Un paragraphe.");
    expect(prompt).toContain("Write page.html in the current directory, plus design-notes.md");
  });

  it("says the route is assigned before delivery when none exists", () => {
    const prompt = buildWixPagePrompt({ ...input, route: "(assigned before delivery)" });
    expect(prompt).toContain("PAGE ROUTE: (assigned before delivery)");
  });

  it("carries the stored design reference and asks for the notes it used", () => {
    const prompt = buildWixPagePrompt({
      ...input,
      design: { repoPath: "/srv/repo", palette: ["#87475b"], fonts: ["Libre Caslon Text"], notes: "Thin rules, no cards." },
      liveUrl: "https://example.com",
    });
    expect(prompt).toContain("/srv/repo");
    expect(prompt).toContain("#87475b");
    expect(prompt).toContain("Libre Caslon Text");
    expect(prompt).toContain("Thin rules, no cards.");
    expect(prompt).toContain("design-notes.md");
  });
});

describe("page fragment validation", () => {
  const valid = `<section ${markerFor("task-123")}><style>[data-crawlseo-task="task-123"] h1{color:red}</style><h1>Condos</h1></section>`;

  it("accepts a scoped fragment", () => {
    expect(pageProblems(valid, "task-123")).toEqual([]);
  });

  it("rejects a full document", () => {
    expect(pageProblems(`<html><body><section ${markerFor("task-123")}></section></body></html>`, "task-123"))
      .toContain("page.html must be a fragment, not a document");
  });

  it("rejects a fragment without the task marker", () => {
    expect(pageProblems("<section><h1>Condos</h1></section>", "task-123"))
      .toContain(`the root section must carry ${markerFor("task-123")}`);
  });

  it("rejects an iframe", () => {
    expect(pageProblems(`<section ${markerFor("task-123")}><iframe src="x"></iframe></section>`, "task-123"))
      .toContain("iframes are not allowed");
  });

  it("rejects an empty file", () => {
    expect(pageProblems("  ", "task-123")).toEqual(["page.html is empty"]);
  });
});
