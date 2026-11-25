import { describe, expect, it } from "vitest";
import { analyzeFiles } from "./analyze-files";

describe("static source analysis", () => {
  it("links only resolved imports and re-exports with exact source evidence", async () => {
    const result = await analyzeFiles([
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
      result.edges
        .filter((edge) => edge.kind === "imports" || edge.kind === "re-exports")
        .map((edge) => [edge.kind, edge.source, edge.target]),
    ).toEqual([
      ["imports", "src/index.ts", "src/run.ts"],
      ["re-exports", "src/index.ts", "src/run.ts"],
    ]);
    expect(
      result.evidence
        .filter((item) =>
          result.edges.some(
            (edge) =>
              edge.evidenceId === item.id &&
              (edge.kind === "imports" || edge.kind === "re-exports"),
          ),
        )
        .map((item) => [item.startLine, item.endLine, item.snippet]),
    ).toEqual([
      [1, 1, 'import { run } from "./run";'],
      [2, 2, 'export { run } from "./run";'],
    ]);
    expect(result.unresolved).toBe(2);
  });
  it("resolves root configuration aliases and re-exports across cycles", async () => {
    const graph = await analyzeFiles([
      {
        path: "tsconfig.json",
        content:
          '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
      },
      { path: "src/index.ts", content: 'import { value } from "@/barrel";' },
      { path: "src/barrel.ts", content: 'export { value } from "./value";' },
      {
        path: "src/value.ts",
        content: 'import "./index"; export const value = 1;',
      },
    ]);
    expect(
      graph.edges.map((edge) => [edge.source, edge.target, edge.kind]),
    ).toEqual([
      ["src/index.ts", "src/barrel.ts", "imports"],
      ["src/barrel.ts", "src/value.ts", "re-exports"],
      ["src/value.ts", "src/index.ts", "imports"],
    ]);
    expect(graph.unresolved).toBe(0);
  });
  it("uses TypeScript module resolution without inventing route edges", async () => {
    const result = await analyzeFiles([
      {
        path: "src/a.ts",
        content: 'import { x } from "./b"; fetch("/api/login");',
      },
      { path: "src/b.ts", content: "export const x = 1" },
      { path: "src/b.js", content: "export const x = 2" },
      { path: "src/server.ts", content: 'app.get("/api/other", handler);' },
    ]);
    expect(
      result.edges
        .filter((edge) => edge.kind === "imports")
        .map((edge) => edge.target),
    ).toEqual(["src/b.ts"]);
    expect(result.edges.some((edge) => edge.kind === "http-route")).toBe(false);
    expect(result.unresolved).toBe(1);
  });
});
