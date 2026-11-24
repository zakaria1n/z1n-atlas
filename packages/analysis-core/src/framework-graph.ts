import type { Node } from "ts-morph";
import type { GraphEdge, GraphEvidence, GraphNode } from "@z1n/contracts";
export type GraphParts = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: GraphEvidence[];
};
export type HttpRoute = {
  nodeId: string;
  path: string;
  method: string;
  evidenceId: string;
  supportingEvidenceIds?: string[];
};
export function relative(node: Node): string {
  return node
    .getSourceFile()
    .getFilePath()
    .replace(/^\/workspace\//, "");
}
export function evidence(node: Node, graph: GraphParts): string {
  const filePath = relative(node),
    id = `${filePath}:${node.getStart()}:${node.getEnd()}:framework`;
  if (!graph.evidence.some((item) => item.id === id))
    graph.evidence.push({
      id,
      filePath,
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      snippet: node.getText(),
    });
  return id;
}
export function addNode(
  node: Node,
  id: string,
  name: string,
  kind: "route" | "http-call" | "database" | "entrypoint",
  graph: GraphParts,
): void {
  graph.nodes.push({
    id,
    path: relative(node),
    exports: [],
    kind,
    name,
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
  });
}
