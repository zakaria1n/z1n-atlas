export type GraphEvidence = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
};
export type GraphNode = { id: string; path: string; exports: string[] };
export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "imports" | "re-exports";
  confidence: "confirmed";
  evidenceId: string;
};
export type CodeGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: GraphEvidence[];
  unresolved: number;
  notice: string;
};
