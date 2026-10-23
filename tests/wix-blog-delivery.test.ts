import { describe, expect, it } from "vitest";
import { markdownToRicos } from "@/lib/delivery/wix-blog";

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
});
