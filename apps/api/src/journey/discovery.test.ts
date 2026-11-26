import { describe, expect, it } from "vitest";
import type { CodeGraph } from "@z1n/contracts";
import { discoverCandidates } from "./discovery";

const files = [
  {
    path: "server/bookings.ts",
    content: "export function createBooking() { return save(); }",
  },
];
const graph: CodeGraph = {
  nodes: [
    {
      id: "route",
      path: "server/api.ts",
      exports: [],
      kind: "route",
      name: "POST /reservations",
      startLine: 1,
    },
    {
      id: "handler",
      path: "server/bookings.ts",
      exports: [],
      kind: "function",
      name: "createBooking",
      startLine: 1,
      endLine: 1,
    },
    {
      id: "other",
      path: "server/pricing.ts",
      exports: [],
      kind: "function",
      name: "price",
      startLine: 1,
    },
  ],
  edges: [
    {
      id: "edge",
      source: "route",
      target: "handler",
      kind: "handles",
      confidence: "framework",
      evidenceId: "proof",
    },
  ],
  evidence: [
    {
      id: "proof",
      filePath: "server/api.ts",
      startLine: 1,
      endLine: 1,
      snippet: "route",
    },
  ],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};
describe("feature discovery", () => {
  it("finds a differently named route through its connected handler", () => {
    const result = discoverCandidates("How does booking work?", files, graph);
    expect(result.slice(0, 2).map((candidate) => candidate.node.id)).toContain(
      "handler",
    );
    const route = result.find((candidate) => candidate.node.id === "route");
    expect(route?.signals).toContain("connected-symbol");
    expect(route?.context.map((node) => node.id)).toContain("handler");
    expect(result.some((candidate) => candidate.node.id === "other")).toBe(
      false,
    );
  });
  it("reports no candidates for unrelated terms", () => {
    expect(discoverCandidates("quantum propulsion", files, graph)).toEqual([]);
  });
});
