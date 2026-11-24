import { describe, expect, it } from "vitest";
import { analyzeFiles } from "./analyze-files";
import { graphIsValid } from "@z1n/contracts";

describe("semantic symbols and calls", () => {
  it("links aliases, re-exports, functions, classes and methods to real declarations", () => {
    const files = [
      {
        path: "tsconfig.json",
        content:
          '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
      },
      {
        path: "src/client.ts",
        content:
          'import {handler} from "@/barrel"; export function run() { const ref = handler; return ref(); }',
      },
      {
        path: "src/barrel.ts",
        content: 'export {handler} from "./controller";',
      },
      {
        path: "src/controller.ts",
        content:
          'import {Service} from "./service"; export function handler() { return new Service().create(); }',
      },
      {
        path: "src/service.ts",
        content: "export class Service { create() { return 1; } }",
      },
    ];
    const graph = analyzeFiles(files);
    expect(graphIsValid(graph, files)).toBe(true);
    const calls = graph.edges
      .filter((edge) => edge.kind === "calls")
      .map((edge) => [
        graph.nodes.find((n) => n.id === edge.source)?.name,
        graph.nodes.find((n) => n.id === edge.target)?.name,
      ]);
    const references = graph.edges
      .filter((edge) => edge.kind === "references")
      .map((edge) => [
        graph.nodes.find((n) => n.id === edge.source)?.name,
        graph.nodes.find((n) => n.id === edge.target)?.name,
      ]);
    expect(references).toContainEqual(["run", "handler"]);
    expect(calls).toContainEqual(["handler", "create"]);
    expect(
      graph.nodes.some(
        (node) => node.kind === "class" && node.name === "Service",
      ),
    ).toBe(true);
    expect(
      graph.nodes.some(
        (node) => node.kind === "method" && node.name === "create",
      ),
    ).toBe(true);
  });
  it("does not invent a call target for an unresolved function", () => {
    const graph = analyzeFiles([
      { path: "src/a.ts", content: "export function run() { unknown(); }" },
    ]);
    expect(graph.edges.filter((edge) => edge.kind === "calls")).toEqual([]);
  });
});
