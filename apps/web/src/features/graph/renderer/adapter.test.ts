import { describe, expect, it } from "vitest";
import type { CodeGraph } from "@z1n/contracts";
import {
  JOURNEY_COLOR,
  NODE_COLOR,
  codeGraphToGraphology,
  mixWithBackground,
} from "./adapter";

const graph: CodeGraph = {
  nodes: [
    { id: "f1", path: "src/a.ts", exports: [] },
    {
      id: "s1",
      path: "src/a.ts",
      exports: [],
      kind: "function",
      name: "alpha",
      startLine: 3,
    },
    {
      id: "s2",
      path: "src/a.ts",
      exports: [],
      kind: "function",
      name: "beta",
      startLine: 9,
    },
    { id: "f2", path: "src/b.ts", exports: [] },
  ],
  edges: [
    {
      id: "e1",
      source: "f1",
      target: "f2",
      kind: "imports",
      confidence: "confirmed",
      evidenceId: "v1",
    },
    {
      id: "e2",
      source: "f1",
      target: "f2",
      kind: "calls",
      confidence: "heuristic",
      evidenceId: "v2",
    },
  ],
  evidence: [],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};

describe("codeGraphToGraphology", () => {
  it("keeps every node and edge identity, including parallel edges", () => {
    const layout = codeGraphToGraphology(graph);
    expect(layout.order).toBe(4);
    expect(layout.size).toBe(2);
    expect(layout.hasEdge("e1")).toBe(true);
    expect(layout.hasEdge("e2")).toBe(true);
    expect(layout.edges("f1", "f2")).toHaveLength(2);
    expect(layout.getEdgeAttribute("e2", "confidence")).toBe("heuristic");
    // Parallel edges curve apart deterministically in opposite directions.
    expect(layout.getEdgeAttribute("e1", "curvature")).toBeCloseTo(0.08);
    expect(layout.getEdgeAttribute("e2", "curvature")).toBeCloseTo(-0.08);
    expect(layout.getEdgeAttribute("e2", "kind")).toBe("calls");
    expect(layout.getNodeAttribute("s1", "kind")).toBe("function");
    expect(layout.getNodeAttribute("s1", "path")).toBe("src/a.ts");
  });

  it("seeds deterministic positions across rebuilds", () => {
    const first = codeGraphToGraphology(graph);
    const second = codeGraphToGraphology(graph);
    for (const node of first.nodes()) {
      expect(first.getNodeAttribute(node, "x")).toBe(
        second.getNodeAttribute(node, "x"),
      );
      expect(first.getNodeAttribute(node, "y")).toBe(
        second.getNodeAttribute(node, "y"),
      );
    }
    // Symbols jitter away from their file instead of stacking on it.
    const file = first.getNodeAttribute("f1", "x");
    const alpha = first.getNodeAttribute("s1", "x");
    expect(alpha).not.toBe(file);
  });

  it("uses identity colors and readable sizes", () => {
    const layout = codeGraphToGraphology(graph);
    expect(layout.getNodeAttribute("f1", "color")).toBe(NODE_COLOR);
    expect(layout.getNodeAttribute("f1", "size")).toBeGreaterThan(
      layout.getNodeAttribute("s1", "size"),
    );
  });

  it("mixes colors toward the ivory background for dimming", () => {
    expect(mixWithBackground(NODE_COLOR, 0)).toBe(NODE_COLOR);
    const dimmed = mixWithBackground(NODE_COLOR, 0.8);
    expect(dimmed).not.toBe(NODE_COLOR);
    expect(mixWithBackground(JOURNEY_COLOR, 0.2)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
