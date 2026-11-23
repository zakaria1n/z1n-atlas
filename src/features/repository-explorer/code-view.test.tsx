import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeView } from "./code-view";

describe("code inspector", () => {
  it("renders source as escaped text with line numbers", () => {
    const source = '<script>alert("unsafe")</script>\nconst value = 1;';
    const html = renderToStaticMarkup(
      <CodeView
        file={{ path: "src/test.ts", size: source.length, content: source }}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
    expect(html).toContain("Source code: src/test.ts");
    expect(html.match(/class="line-number"/g) ?? []).toHaveLength(2);
  });
});
