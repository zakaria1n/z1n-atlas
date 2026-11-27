import { MultiDirectedGraph } from "graphology";
import type { CodeGraph } from "@z1n/contracts";
import { connectedComponents } from "graphology-components";
import * as shortestPath from "graphology-shortest-path";

/**
 * A directed multigraph adapter over the serialized CodeGraph. Every edge
 * keeps its kind, direction and confidence as attributes, and parallel
 * relationships between the same two nodes stay distinct. The CodeGraph
 * contract remains the authoritative serialized form; this adapter is a
 * repository-scoped algorithm layer, not a second representation of truth.
 */
export type GraphAdapter = {
  graph: MultiDirectedGraph;
  neighbors(nodeId: string): string[];
  outbound(nodeId: string): string[];
  inbound(nodeId: string): string[];
  shortestPath(from: string, to: string): string[] | null;
  connectedComponents(): string[][];
  /** Edges between two nodes in one direction, with kinds. */
  edgesBetween(
    source: string,
    target: string,
  ): { id: string; kind?: string; confidence?: string }[];
};

export function createGraphAdapter(graph: CodeGraph): GraphAdapter {
  const multi = new MultiDirectedGraph();
  for (const node of graph.nodes)
    if (!multi.hasNode(node.id))
      multi.addNode(node.id, { path: node.path, kind: node.kind ?? "file" });
  for (const edge of graph.edges)
    if (
      multi.hasNode(edge.source) &&
      multi.hasNode(edge.target) &&
      !multi.hasEdge(edge.id)
    )
      multi.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
        kind: edge.kind,
        confidence: edge.confidence,
      });
  return {
    graph: multi,
    neighbors: (nodeId) =>
      multi.hasNode(nodeId) ? multi.neighbors(nodeId) : [],
    outbound: (nodeId) =>
      multi.hasNode(nodeId) ? multi.outboundNeighbors(nodeId) : [],
    inbound: (nodeId) =>
      multi.hasNode(nodeId) ? multi.inboundNeighbors(nodeId) : [],
    shortestPath: (from, to) => {
      if (!multi.hasNode(from) || !multi.hasNode(to)) return null;
      const walked = shortestPath.bidirectional(multi, from, to);
      return walked ?? null;
    },
    connectedComponents: () =>
      connectedComponents(multi).map((component) => [...component]),
    edgesBetween: (source, target) => {
      if (!multi.hasNode(source) || !multi.hasNode(target)) return [];
      return multi.edges(source, target).map((edge: string) => ({
        id: edge,
        kind: multi.getEdgeAttribute(edge, "kind") as string | undefined,
        confidence: multi.getEdgeAttribute(edge, "confidence") as
          string | undefined,
      }));
    },
  };
}
