import { describe, expect, it } from "vitest";
import { analyzeFiles } from "./analyze-files";

describe("static source analysis", () => {
  it("links only resolved imports and re-exports with exact source evidence", () => {
    const result = analyzeFiles([
      {
        path: "src/index.ts",
        content:
          'import { run } from "./run";\nexport { run } from "./run";\nimport missing from "./missing";\nimport("./dynamic");',
      },
      { path: "src/run.ts", content: "export function run() { return 1; }" },
      { path: "src/dynamic.ts", content: "export const value = 1;" },
    ]);
    expect(
      result.nodes.find((node) => node.path === "src/run.ts")?.exports,
    ).toEqual(["run"]);
    expect(
      result.edges.map((edge) => [edge.kind, edge.source, edge.target]),
    ).toEqual([
      ["imports", "src/index.ts", "src/run.ts"],
      ["re-exports", "src/index.ts", "src/run.ts"],
    ]);
    expect(
      result.evidence.map((item) => [
        item.startLine,
        item.endLine,
        item.snippet,
      ]),
    ).toEqual([
      [1, 1, 'import { run } from "./run";'],
      [2, 2, 'export { run } from "./run";'],
    ]);
    expect(result.unresolved).toBe(2);
  });
  it("does not invent edges for ambiguous paths or unmatched routes", () => {
    const result = analyzeFiles([
      {
        path: "src/a.ts",
        content: 'import { x } from "./b"; fetch("/api/login");',
      },
      { path: "src/b.ts", content: "export const x = 1" },
      { path: "src/b.js", content: "export const x = 2" },
      { path: "src/server.ts", content: 'app.get("/api/other", handler);' },
    ]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toBe(1);
  });
});
