import type { Node, SourceFile } from "ts-morph";
import type { GraphEdge, GraphEvidence, GraphNode } from "@z1n/contracts";
import type { AnalyzerFile } from "./analyze-files";
import type { ManifestLookup } from "./next-manifest";
import type { SourceNodes, SymbolNames } from "./source-nodes";
import type { SymbolIndex } from "./symbols-and-calls";

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
/**
 * Everything the relationship passes share: the imported files, the nodes
 * collected from each source file, the graph under construction, the names
 * that can resolve to a tracked declaration and the parsed package manifests.
 */
export type AnalysisContext = {
  files: AnalyzerFile[];
  sources: SourceNodes[];
  paths: Set<string>;
  graph: GraphParts;
  names: SymbolNames;
  manifests: ManifestLookup;
};
export type SymbolContext = AnalysisContext & { symbols: SymbolIndex };

const relativePaths = new WeakMap<SourceFile, string>();
export function relative(node: Node): string {
  const source = node.getSourceFile();
  let path = relativePaths.get(source);
  if (path === undefined) {
    path = source.getFilePath().replace(/^\/workspace\//, "");
    relativePaths.set(source, path);
  }
  return path;
}

const evidenceIndexes = new WeakMap<GraphEvidence[], Set<string>>();
function evidenceIndex(graph: GraphParts): Set<string> {
  let index = evidenceIndexes.get(graph.evidence);
  if (!index) {
    index = new Set(graph.evidence.map((item) => item.id));
    evidenceIndexes.set(graph.evidence, index);
  }
  return index;
}
/** Adds evidence unless an entry with the same identifier already exists. */
export function addEvidence(item: GraphEvidence, graph: GraphParts): string {
  const index = evidenceIndex(graph);
  if (!index.has(item.id)) {
    index.add(item.id);
    graph.evidence.push(item);
  }
  return item.id;
}
export function evidence(node: Node, graph: GraphParts): string {
  return addEvidence(
    {
      id: `${relative(node)}:${node.getStart()}:${node.getEnd()}:framework`,
      filePath: relative(node),
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      snippet: node.getText(),
    },
    graph,
  );
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
