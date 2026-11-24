import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Welcome } from "./welcome";

describe("welcome screen", () => {
  it("provides a real path to import and accurately states availability", () => {
    const html = renderToStaticMarkup(<Welcome />);
    expect(html).toContain('href="/import"');
    expect(html).toContain("in development");
    expect(html).toContain("<main");
  });
});
