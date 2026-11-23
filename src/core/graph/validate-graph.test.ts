import { describe, expect, it } from "vitest";
import { analyzeFiles } from "@/server/analyzer/analyze-files";
import { graphIsValid } from "./validate-graph";
describe("graph invariants", () => {
  it("accepts verified evidence and rejects missing or altered references", () => {
    const files = [
      { path: "a.ts", content: 'import "./b";' },
      { path: "b.ts", content: "export const b = 1;" },
    ];
    const graph = analyzeFiles(files);
    expect(graphIsValid(graph, files)).toBe(true);
    expect(
      graphIsValid(
        { ...graph, edges: [{ ...graph.edges[0], target: "missing.ts" }] },
        files,
      ),
    ).toBe(false);
    expect(
      graphIsValid(
        { ...graph, evidence: [{ ...graph.evidence[0], startLine: 2 }] },
        files,
      ),
    ).toBe(false);
    expect(
      graphIsValid(
        { ...graph, evidence: [{ ...graph.evidence[0], snippet: "invented" }] },
        files,
      ),
    ).toBe(false);
  });
});
