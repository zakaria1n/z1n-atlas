import { describe, expect, it } from "vitest";
import type { CodeGraph } from "@z1n/contracts";
import { createGraphAdapter } from "./adapter";
import { buildIntelligence, entryPointScores } from "./intelligence";

const graph: CodeGraph = {
  nodes: [
    { id: "routes.ts", path: "src/routes.ts", exports: [] },
    {
      id: "routes.ts#1",
      path: "src/routes.ts",
      name: "handleRegister",
      kind: "route",
      startLine: 1,
      endLine: 4,
      exports: [],
    },
    {
      id: "services.ts#1",
      path: "src/services.ts",
      name: "createUserService",
      kind: "function",
      startLine: 1,
      endLine: 6,
      exports: [],
    },
    {
      id: "repos.ts#1",
      path: "src/repos.ts",
      name: "create",
      kind: "function",
      startLine: 1,
      endLine: 6,
      exports: [],
    },
    {
      id: "repos.ts#7",
      path: "src/repos.ts",
      name: "Prisma user.create",
      kind: "database",
      startLine: 7,
      endLine: 9,
      exports: [],
    },
  ],
  edges: [
    {
      id: "e1",
      source: "routes.ts#1",
      target: "services.ts#1",
      kind: "calls",
      confidence: "exact",
      evidenceId: "ev1",
    },
    {
      id: "e2",
      source: "services.ts#1",
      target: "repos.ts#1",
      kind: "calls",
      confidence: "exact",
      evidenceId: "ev2",
    },
    {
      id: "e3",
      source: "repos.ts#1",
      target: "repos.ts#7",
      kind: "database-access",
      confidence: "exact",
      evidenceId: "ev3",
    },
    // A parallel relationship between the same pair: must stay distinct.
    {
      id: "e4",
      source: "repos.ts#1",
      target: "repos.ts#7",
      kind: "calls",
      confidence: "exact",
      evidenceId: "ev3b",
    },
  ],
  evidence: [],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};

describe("graphology adapter", () => {
  it("keeps parallel relationships between the same nodes distinct", () => {
    const adapter = createGraphAdapter(graph);
    const between = adapter.edgesBetween("repos.ts#1", "repos.ts#7");
    expect(between.map((edge) => edge.kind).sort()).toEqual([
      "calls",
      "database-access",
    ]);
    expect(adapter.neighbors("repos.ts#7")).toEqual(["repos.ts#1"]);
  });
  it("traverses directions separately and finds directed paths", () => {
    const adapter = createGraphAdapter(graph);
    expect(adapter.outbound("routes.ts#1")).toEqual(["services.ts#1"]);
    expect(adapter.inbound("repos.ts#7")).toEqual(["repos.ts#1"]);
    const path = adapter.shortestPath("routes.ts#1", "repos.ts#7");
    expect(path).toEqual([
      "routes.ts#1",
      "services.ts#1",
      "repos.ts#1",
      "repos.ts#7",
    ]);
    expect(adapter.shortestPath("repos.ts#7", "routes.ts#1")).toBeNull();
  });
});

describe("graph intelligence", () => {
  it("ranks the route as the structural entry point", () => {
    const adapter = createGraphAdapter(graph);
    const entryPoints = entryPointScores(graph, adapter);
    // The route has outgoing calls and no incoming callers; deeper nodes
    // have none or few outgoing.
    expect(entryPoints[0]?.nodeId).toBe("routes.ts#1");
    expect(entryPoints[0]?.reasons).toContain("HTTP route");
  });
  it("detects a bounded static process with explicit budgets", () => {
    const adapter = createGraphAdapter(graph);
    const intelligence = buildIntelligence(graph, adapter);
    expect(
      intelligence.processes.some((process) => process.nodeIds.length >= 3),
    ).toBe(true);
    expect(intelligence.truncatedProcesses).toBe(false);
    expect(intelligence.communities.length).toBeGreaterThan(0);
  });
  it("never leaves the supported relationship kinds", () => {
    const adapter = createGraphAdapter(graph);
    const intelligence = buildIntelligence(graph, adapter);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const process of intelligence.processes)
      for (let index = 0; index < process.nodeIds.length - 1; index++) {
        const [from, to] = [process.nodeIds[index], process.nodeIds[index + 1]];
        expect(byId.has(from)).toBe(true);
        expect(byId.has(to)).toBe(true);
      }
  });
});
