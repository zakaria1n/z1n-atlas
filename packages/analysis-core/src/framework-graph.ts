import type { CallExpression, Node, SourceFile } from "ts-morph";
import type {
  GraphEdge,
  GraphEvidence,
  GraphNode,
  GraphUnresolved,
} from "@z1n/contracts";
import type { AnalyzerFile } from "./analyze-files";
import type { ManifestLookup } from "./next-manifest";
import type { SourceNodes, SymbolNames } from "./source-nodes";
import type { SymbolIndex } from "./symbols-and-calls";
import { workspacePath } from "./workspace";

// The list is a bounded sample: the totals stay in the graph counters, and a
// very large selection must not ship thousands of entries to the browser.
const MAX_UNRESOLVED_ITEMS = 300;

export type GraphParts = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: GraphEvidence[];
  unresolvedItems: GraphUnresolved[];
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
  /** JSX files whose React conventions are backed by an import or a package manifest. */
  reactFiles: Set<string>;
};
export type SymbolContext = AnalysisContext & {
  symbols: SymbolIndex;
  /** Target of each call that resolved to a tracked declaration, keyed by the call. */
  callTargets: Map<CallExpression, string>;
};

const relativePaths = new WeakMap<SourceFile, string>();
export function relative(node: Node): string {
  const source = node.getSourceFile();
  let path = relativePaths.get(source);
  if (path === undefined) {
    path = workspacePath(source.getFilePath());
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
/** A place in an analyzed file, described without a parser-specific node. */
export type SourceLocation = {
  filePath: string;
  /** Start offset inside the file, so the identifier is stable across passes. */
  start: number;
  startLine: number;
  endLine: number;
  snippet: string;
};
/** Records a relationship that could not be established, at the code that would establish it. */
export function addUnresolvedLocation(
  graph: GraphParts,
  location: SourceLocation,
  kind: GraphUnresolved["kind"],
  reason: string,
): void {
  const items = graph.unresolvedItems;
  const id = `${location.filePath}:${location.start}:${kind}`;
  if (
    items.length >= MAX_UNRESOLVED_ITEMS ||
    items.some((item) => item.id === id)
  )
    return;
  items.push({
    id,
    filePath: location.filePath,
    startLine: location.startLine,
    endLine: location.endLine,
    snippet: location.snippet.slice(0, 400),
    kind,
    reason,
  });
}
/** Records a relationship that could not be established, at the code that would establish it. */
export function addUnresolved(
  node: Node,
  context: AnalysisContext,
  kind: GraphUnresolved["kind"],
  reason: string,
): void {
  addUnresolvedLocation(
    context.graph,
    {
      filePath: relative(node),
      start: node.getStart(),
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      snippet: node.getText(),
    },
    kind,
    reason,
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
