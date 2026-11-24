export type GraphEvidence = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
};
export type GraphNode = {
  id: string;
  path: string;
  exports: string[];
  kind?:
    | "file"
    | "function"
    | "method"
    | "class"
    | "route"
    | "http-call"
    | "database"
    | "entrypoint";
  name?: string;
  startLine?: number;
  endLine?: number;
};
export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind:
    | "imports"
    | "re-exports"
    | "contains"
    | "calls"
    | "references"
    | "requests"
    | "http-route"
    | "handles"
    | "handles-event"
    | "database-access"
    | "renders";
  confidence: "confirmed" | "framework" | "heuristic";
  evidenceId: string;
  supportingEvidenceIds?: string[];
};
export type CodeGraph = {
  analysisId?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: GraphEvidence[];
  unresolved: number;
  unresolvedCalls: number;
  notice: string;
};
