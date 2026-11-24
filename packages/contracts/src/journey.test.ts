import { describe, expect, it } from "vitest";
import type { CodeGraph } from "./graph/contracts";
import { journeyIsValid, journeySchema } from "./journey";
const graph: CodeGraph = {
  nodes: [
    { id: "a", path: "a.ts", exports: [] },
    { id: "b", path: "b.ts", exports: [] },
  ],
  edges: [
    {
      id: "edge",
      source: "a",
      target: "b",
      kind: "calls",
      confidence: "confirmed",
      evidenceId: "e",
    },
  ],
  evidence: [
    { id: "e", filePath: "a.ts", startLine: 1, endLine: 1, snippet: "b()" },
  ],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};
describe("journey references", () => {
  it("accepts directed paths and explicit unknown boundaries", () => {
    expect(
      journeyIsValid(
        journeySchema.parse({
          nodeIds: ["a", "b"],
          edgeIds: ["edge"],
          uncertainties: ["Static path only."],
        }),
        graph,
      ),
    ).toBe(true);
    expect(
      journeyIsValid(
        journeySchema.parse({
          nodeIds: [],
          edgeIds: [],
          uncertainties: ["No match."],
        }),
        graph,
      ),
    ).toBe(true);
  });
  it("rejects invented, reversed, disconnected and cyclic paths", () => {
    for (const path of [
      { nodeIds: ["b", "a"], edgeIds: ["edge"] },
      { nodeIds: ["a", "b"], edgeIds: ["fake"] },
      { nodeIds: ["a", "b", "a"], edgeIds: ["edge", "edge"] },
    ])
      expect(
        journeyIsValid({ ...path, uncertainties: ["unknown"] }, graph),
      ).toBe(false);
  });
});
