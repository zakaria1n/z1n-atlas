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
/**
 * A relationship the analysis could not establish, reported at its source
 * location so that a gap in a journey can be inspected instead of guessed.
 */
export type GraphUnresolved = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  kind: "import" | "request" | "route" | "handler";
  reason: string;
};
export type CodeGraph = {
  analysisId?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: GraphEvidence[];
  unresolved: number;
  unresolvedCalls: number;
  /** Bounded sample of the unresolved imports, requests, routes and handlers. */
  unresolvedItems?: GraphUnresolved[];
  notice: string;
};
