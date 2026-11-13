import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { editorialEnabled, editorialTerminal } from "@/lib/editorial-service/client";
import { internalLinks, selectEvidenceUrls } from "@/lib/editorial-service/brief";

describe("editorial evidence selection", () => {
  const pages = [
    { url: "https://atelier.example/", title: "Atelier Harmonie", wordCount: 400 },
    { url: "https://atelier.example/les-tissus", title: "Les tissus", wordCount: 900 },
    { url: "https://atelier.example/post/retapisser-un-fauteuil", title: "Retapisser un fauteuil", wordCount: 1200 },
    { url: "https://atelier.example/mentions-legales", title: "Mentions légales", wordCount: 800 },
    { url: "https://atelier.example/thin", title: "Thin page", wordCount: 40 },
  ];

  it("puts the page that answers the query first and keeps the homepage as context", () => {
    const urls = selectEvidenceUrls(pages, "retapisser fauteuil", "comment retapisser un fauteuil soi même", 3);
    expect(urls[0]).toBe("https://atelier.example/post/retapisser-un-fauteuil");
    expect(urls).toContain("https://atelier.example/");
    expect(urls).toHaveLength(3);
  });

  it("prefers the page that explains the method over a tag or product page", () => {
    const urls = selectEvidenceUrls(
      [
        { url: "https://atelier.example/post/refection-fauteuil", title: "Réfection d'un fauteuil", wordCount: 500 },
        { url: "https://atelier.example/post/la-tapisserie-traditionnelle", title: "La tapisserie traditionnelle", wordCount: 900 },
        { url: "https://atelier.example/blog/tags/fauteuil", title: "fauteuil", wordCount: 400 },
        { url: "https://atelier.example/product-page/fauteuil-paon", title: "Fauteuil paon", wordCount: 600 },
        { url: "https://atelier.example/", title: "Atelier", wordCount: 400 },
      ],
      "retapisser fauteuil dégarnissage sanglage garnissage tapisserie",
      "comment retapisser un fauteuil",
      6,
    );
    expect(urls.slice(0, 2)).toContain("https://atelier.example/post/la-tapisserie-traditionnelle");
    expect(urls).toContain("https://atelier.example/post/refection-fauteuil");
    expect(urls).not.toContain("https://atelier.example/blog/tags/fauteuil");
    expect(urls).not.toContain("https://atelier.example/product-page/fauteuil-paon");
  });

  it("drops boilerplate and pages too thin to quote", () => {
    const urls = selectEvidenceUrls(pages, "tissus fauteuil", "tissu fauteuil", 10);
    expect(urls).not.toContain("https://atelier.example/mentions-legales");
    expect(urls).not.toContain("https://atelier.example/thin");
  });
});

describe("brief requirements", () => {
  it("keeps the internal links the instruction names", () => {
    expect(internalLinks("un encadré renvoyant vers /devis et vers /les-ateliers.")).toEqual(["/devis", "/les-ateliers"]);
    expect(internalLinks("aucun lien ici")).toEqual([]);
  });
});

describe("editorial client configuration", () => {
  it("is disabled without a URL or token and enabled with both", () => {
    const url = process.env.EDITORIAL_URL;
    const token = process.env.EDITORIAL_TOKEN;
    delete process.env.EDITORIAL_URL;
    delete process.env.EDITORIAL_TOKEN;
    expect(editorialEnabled()).toBe(false);

    process.env.EDITORIAL_URL = "http://127.0.0.1:8790";
    process.env.EDITORIAL_TOKEN = "token";
    expect(editorialEnabled()).toBe(true);

    if (url === undefined) delete process.env.EDITORIAL_URL;
    else process.env.EDITORIAL_URL = url;
    if (token === undefined) delete process.env.EDITORIAL_TOKEN;
    else process.env.EDITORIAL_TOKEN = token;
  });

  it("treats only settled states as terminal", () => {
    for (const state of ["ready", "published", "held", "failed", "cancelled"]) {
      expect(editorialTerminal(state)).toBe(true);
    }
    for (const state of ["queued", "researching", "planning", "drafting", "verifying"]) {
      expect(editorialTerminal(state)).toBe(false);
    }
  });
});

describe("article lane wiring", () => {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  it("sends a new article to editorial when the service is configured", () => {
    const source = read("lib/agent-tasks/wix-article.ts");
    expect(source).toContain("editorialEnabled()");
    expect(source).toContain("startEditorialArticleTask");
    // An existing post keeps the update path; only a new asset is editorial work.
    expect(source).toContain("!existingPost && editorialEnabled()");
    const brief = read("lib/editorial-service/brief.ts");
    expect(brief).toContain('target: { mode: "new", url: action.targetUrl ?? "" }');
  });

  it("does not treat a proposed new post URL as an existing post", () => {
    const source = read("lib/agent-tasks/wix-article.ts");
    // A new guide is proposed at the URL it will occupy; only the
    // recommendation's newAsset flag can tell it apart from an update.
    expect(source).toContain("newAsset !== true");
    expect(source).toContain("recommendationDecision");
  });

  it("polls through the durable queue and defers instead of retrying", () => {
    const worker = read("scripts/job-worker.ts");
    expect(worker).toContain("JobKind.EDITORIAL_ARTICLE");
    expect(worker).toContain("EDITORIAL_STILL_WRITING\", true");
    const schema = read("prisma/schema.prisma");
    expect(schema).toContain("EDITORIAL_ARTICLE");
  });
});
