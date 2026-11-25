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
const journey = (values: Record<string, unknown>) =>
  journeySchema.parse({
    uncertainties: ["unknown"],
    mode: "static",
    ...values,
  });
describe("journey references", () => {
  it("accepts directed paths and explicit unknown boundaries", () => {
    expect(
      journeyIsValid(
        journey({ nodeIds: ["a", "b"], edgeIds: ["edge"] }),
        graph,
      ),
    ).toBe(true);
    expect(journeyIsValid(journey({ nodeIds: [], edgeIds: [] }), graph)).toBe(
      true,
    );
  });
  it("rejects invented, reversed, disconnected and cyclic paths", () => {
    for (const path of [
      { nodeIds: ["b", "a"], edgeIds: ["edge"] },
      { nodeIds: ["a", "b"], edgeIds: ["fake"] },
      { nodeIds: ["a", "b", "a"], edgeIds: ["edge", "edge"] },
    ])
      expect(
        journeyIsValid(
          { ...path, mode: "static", uncertainties: ["unknown"] },
          graph,
        ),
      ).toBe(false);
  });
  it("accepts explanations for path nodes and rejects foreign or duplicated ones", () => {
    expect(
      journeyIsValid(
        journey({
          nodeIds: ["a", "b"],
          edgeIds: ["edge"],
          explanations: [
            { nodeId: "a", text: "The form the user fills in." },
            { nodeId: "b", text: "Called with the input." },
          ],
        }),
        graph,
      ),
    ).toBe(true);
    expect(
      journeyIsValid(
        journey({
          nodeIds: ["a", "b"],
          edgeIds: ["edge"],
          explanations: [{ nodeId: "invented", text: "Not on the path." }],
        }),
        graph,
      ),
    ).toBe(false);
    expect(
      journeyIsValid(
        journey({
          nodeIds: ["a", "b"],
          edgeIds: ["edge"],
          explanations: [
            { nodeId: "a", text: "First." },
            { nodeId: "a", text: "Again." },
          ],
        }),
        graph,
      ),
    ).toBe(false);
  });
});
