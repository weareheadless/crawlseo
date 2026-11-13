import { describe, expect, it } from "vitest";
import { countRicosImages, markdownToRicos, proposesNewAsset } from "@/lib/delivery/wix-blog";

describe("Wix Blog delivery target", () => {
  it("tells a proposed new post from an existing one", () => {
    expect(proposesNewAsset({ recommendationDecision: { target: { url: "https://x/post/new", newAsset: true } } })).toBe(true);
    expect(proposesNewAsset({ recommendationDecision: { target: { url: "https://x/post/old", newAsset: false } } })).toBe(false);
    expect(proposesNewAsset({})).toBe(false);
    expect(proposesNewAsset(null)).toBe(false);
  });
});

describe("Wix Blog rich content", () => {
  it("skips a duplicate H1, maps headings, paragraphs, and bullets", () => {
    const rich = markdownToRicos(
      "# Test Title\n\nIntro paragraph.\n\n## Section\n\n- First\n- Second\n\nClosing.",
      "Test Title",
    );
    const types = rich.nodes.map((node) => (node as { type: string }).type);
    expect(types).toEqual(["PARAGRAPH", "HEADING", "BULLETED_LIST", "PARAGRAPH"]);
    const heading = rich.nodes.find((node) => (node as { type: string }).type === "HEADING") as {
      headingData: { level: number };
      nodes: Array<{ textData: { text: string } }>;
    };
    expect(heading.headingData.level).toBe(2);
    expect(heading.nodes[0].textData.text).toBe("Section");
  });

  it("keeps a different first H1 as a body heading", () => {
    const rich = markdownToRicos("# Different title\n\nBody.", "Post title");
    expect((rich.nodes[0] as { type: string }).type).toBe("HEADING");
  });

  it("keeps inline links and deep headings instead of leaking markdown", () => {
    const rich = markdownToRicos(
      "## Section\n\n#### Detail\n\nVoir [/devis](/devis) et **le guide**.",
      "Post title",
    );
    const types = rich.nodes.map((node) => (node as { type: string }).type);
    expect(types).toEqual(["HEADING", "HEADING", "PARAGRAPH"]);
    const detail = rich.nodes[1] as { headingData: { level: number }; nodes: Array<{ textData: { text: string } }> };
    expect(detail.headingData.level).toBe(4);
    expect(detail.nodes[0].textData.text).toBe("Detail");
    const paragraph = rich.nodes[2] as {
      nodes: Array<{ textData: { text: string; decorations: Array<{ type: string; linkData?: { link: { url: string } } }> } }>;
    };
    const link = paragraph.nodes.find((node) => node.textData.decorations.some((d) => d.type === "LINK"));
    expect(link?.textData.text).toBe("/devis");
    expect(link?.textData.decorations[0].linkData?.link.url).toBe("/devis");
    expect(JSON.stringify(rich)).not.toContain("](/devis)");
  });

  it("places inline images where the writer marked them, with credit", () => {
    const images = new Map([["img_2", {
      mediaId: "media-1",
      url: "https://media.wix.com/photo.jpg",
      altText: "un fauteuil en cours de retapissage",
      width: 1600,
      height: 1067,
      credit: "Photo de Camille Martin sur Unsplash",
      creditUrl: "https://unsplash.com/@camille",
    }]]);
    const rich = markdownToRicos(
      "## Dégarnissage\n\n<!-- image: img_2 -->\n\nLe tissu se retire.",
      "Post title",
      images,
    );
    const types = rich.nodes.map((node) => (node as { type: string }).type);
    expect(types).toEqual(["HEADING", "IMAGE", "PARAGRAPH", "PARAGRAPH"]);
    const image = rich.nodes[1] as { imageData: { image: { src: { id: string } }; altText: string } };
    expect(image.imageData.image.src.id).toBe("media-1");
    expect(image.imageData.altText).toContain("fauteuil");
    expect(countRicosImages(rich.nodes)).toBe(1);
    const credit = rich.nodes[2] as { nodes: Array<{ textData: { text: string; decorations: Array<{ type: string; linkData?: { link: { url: string } } }> } }> };
    expect(credit.nodes[0].textData.text).toBe("Photo de Camille Martin sur Unsplash");
    expect(credit.nodes[0].textData.decorations[0].linkData?.link.url).toBe("https://unsplash.com/@camille");
    expect(JSON.stringify(rich)).not.toContain("<!-- image");
  });

  it("drops a marker whose image could not be imported", () => {
    const rich = markdownToRicos(
      "## Dégarnissage\n\n<!-- image: img_9 -->\n\nLe tissu se retire.",
      "Post title",
      new Map(),
    );
    expect(JSON.stringify(rich)).not.toContain("img_9");
    expect(rich.nodes.map((node) => (node as { type: string }).type)).toEqual(["HEADING", "PARAGRAPH"]);
  });

  it("converts markdown bold into Ricos BOLD decorations", () => {
    const rich = markdownToRicos(
      "## Section\n\nThis is **important** text.\n\n- **Bold item** with plain text.",
      "Post title",
    );
    const heading = rich.nodes.find((node) => (node as { type: string }).type === "HEADING") as {
      nodes: Array<{ textData: { decorations: Array<{ type: string }> } }>;
    };
    expect(heading.nodes[0].textData.decorations).toContainEqual({ type: "BOLD", fontWeightValue: 700 });

    const paragraph = rich.nodes.find((node) => (node as { type: string }).type === "PARAGRAPH") as {
      nodes: Array<{ textData: { text: string; decorations: Array<{ type: string }> } }>;
    };
    expect(paragraph.nodes.some((node) => node.textData.text === "important"
      && node.textData.decorations.some((decoration) => decoration.type === "BOLD"))).toBe(true);

    const list = rich.nodes.find((node) => (node as { type: string }).type === "BULLETED_LIST") as {
      nodes: Array<{ nodes: Array<{ nodes: Array<{ textData: { text: string; decorations: Array<{ type: string }> } }> }> }>;
    };
    const itemText = list.nodes[0].nodes[0].nodes;
    expect(itemText.some((node) => node.textData.text === "Bold item"
      && node.textData.decorations.some((decoration) => decoration.type === "BOLD"))).toBe(true);
    expect(JSON.stringify(list)).not.toContain("**");
  });
});
