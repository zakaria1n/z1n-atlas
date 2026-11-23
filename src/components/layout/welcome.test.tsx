import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Welcome } from "./welcome";

describe("welcome screen", () => {
  it("identifies the product and describes unavailable capabilities honestly", () => {
    const html = renderToStaticMarkup(<Welcome />);
    expect(html).toContain('alt="Z1N Atlas"');
    expect(html).toContain("not available yet");
    expect(html).toContain("<main");
    expect(html).not.toContain("<button");
  });
});
