"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import type { CodeGraph, GraphEdge, Journey } from "@z1n/contracts";
import type { RepositorySession } from "@/features/repository-import/repository-session";
import { JourneyPanel } from "./journey-panel";
import { GraphViewport, type GraphScope } from "./graph-viewport";
import type { ViewportApi } from "./renderer/sigma-graph";

type Props = {
  graph: CodeGraph;
  session: RepositorySession;
  onOpenFile: (path: string, line?: number) => void;
};
const RELATIONSHIP_PAGE = 100;
// Mirrors the renderer's label threshold so the disclosure matches what the
// React Flow modes actually draw; Sigma manages label density itself.
const LABELLED_EDGE_LIMIT = 400;

export function GraphCanvas({ graph, session, onOpenFile }: Props) {
  const [filter, setFilter] = useState("all");
  const [scope, setScope] = useState<GraphScope>("files");
  const viewportApi = useRef<ViewportApi | null>(null);
  const [layoutRunning, setLayoutRunning] = useState(false);
  const [selected, setSelected] = useState<GraphEdge | null>(null);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [focus, setFocus] = useState<{ nodeId: string; nonce: number } | null>(
    null,
  );
  const [relationshipQuery, setRelationshipQuery] = useState("");
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );
  const labelOf = useMemo(
    () => (id: string) => byId.get(id)?.name ?? byId.get(id)?.path ?? id,
    [byId],
  );
  const journeyEdges = useMemo(
    () => new Set(journey?.edgeIds ?? []),
    [journey],
  );
  const visibleEdges = useMemo(() => {
    const isFile = (id: string) => {
      const node = byId.get(id);
      return !node?.kind || node.kind === "file";
    };
    return graph.edges.filter(
      (edge) =>
        (scope !== "files" || (isFile(edge.source) && isFile(edge.target))) &&
        (scope !== "journey" || journeyEdges.has(edge.id)) &&
        (filter === "all" || edge.kind === filter),
    );
  }, [graph, scope, journeyEdges, filter, byId]);
  const listed = useMemo(() => {
    const needle = relationshipQuery.trim().toLowerCase();
    const matches = needle
      ? visibleEdges.filter((edge) =>
          `${labelOf(edge.source)} ${labelOf(edge.target)} ${edge.kind}`
            .toLowerCase()
            .includes(needle),
        )
      : visibleEdges;
    return {
      edges: matches.slice(0, RELATIONSHIP_PAGE),
      total: matches.length,
    };
  }, [visibleEdges, relationshipQuery, labelOf]);
  const proofs = selected
    ? [selected.evidenceId, ...(selected.supportingEvidenceIds ?? [])]
        .map((id) => graph.evidence.find((item) => item.id === id))
        .filter((item) => item !== undefined)
    : [];
  // Selecting a relationship highlights its endpoints in the renderer and can
  // be driven from the list (which also re-aims the camera), from an edge
  // click or from keyboard focus.
  const selectEdge = useCallback((edge: GraphEdge) => {
    setSelected(edge);
  }, []);
  const selectEdgeFromList = useCallback((edge: GraphEdge) => {
    setSelected(edge);
    setFocus({ nodeId: edge.source, nonce: Date.now() });
  }, []);
  const clearSelection = useCallback(() => setSelected(null), []);
  return (
    <section
      className="graph-container"
      aria-label="Source relationship graph"
      onKeyDownCapture={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const nodeElement = target.closest(".react-flow__node");
        const edgeElement = target.closest(".react-flow__edge");
        if (nodeElement) {
          const item = byId.get(nodeElement.getAttribute("data-id") ?? "");
          if (item) {
            event.preventDefault();
            event.stopPropagation();
            onOpenFile(item.path, item.startLine);
          }
        } else if (edgeElement) {
          const item = graph.edges.find(
            (edge) => edge.id === edgeElement.getAttribute("data-id"),
          );
          if (item) {
            event.preventDefault();
            event.stopPropagation();
            selectEdge(item);
          }
        }
      }}
    >
      <div className="graph-info">
        <strong>Source relationships</strong>
        <span>Blue: static or framework · amber: heuristic</span>
        <span>
          {graph.unresolved} unresolved imports or routes ·{" "}
          {graph.unresolvedCalls} unresolved calls
        </span>
        {session.inventory &&
          session.inventory.length > session.files.length && (
            <span>
              Analyzing {session.files.length} of {session.inventory.length}{" "}
              indexed files; coverage is partial.
            </span>
          )}
        {visibleEdges.length > LABELLED_EDGE_LIMIT && (
          <span>
            Edge labels are hidden on this many relationships. Select an edge to
            see its type.
          </span>
        )}
        <JourneyPanel
          session={session}
          graph={graph}
          journey={journey}
          onJourney={(value) => {
            setJourney(value);
            if (value) {
              setFilter("all");
              if (value.nodeIds.length) setScope("journey");
            } else if (scope === "journey") setScope("files");
          }}
          onOpenFile={onOpenFile}
        />
        <label htmlFor="graph-scope">Graph scope</label>
        <select
          id="graph-scope"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value as GraphScope);
          }}
        >
          <option value="files">Files</option>
          <option value="all">Files and symbols</option>
          {journey && journey.nodeIds.length > 0 && (
            <option value="journey">Current journey</option>
          )}
        </select>
        <label htmlFor="edge-filter">Relationship type</label>
        <select
          id="edge-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All relationships</option>
          {[...new Set(graph.edges.map((edge) => edge.kind))]
            .sort()
            .map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
        </select>
        <details>
          <summary>Analysis coverage</summary>
          <p>{graph.notice}</p>
        </details>
        <details>
          <summary>Inspect relationships ({visibleEdges.length})</summary>
          <label className="relations-filter">
            Filter relationships
            <input
              type="search"
              value={relationshipQuery}
              onChange={(event) => setRelationshipQuery(event.target.value)}
              placeholder="Symbol, file or type"
            />
          </label>
          <ul className="relations">
            {listed.edges.map((edge) => (
              <li key={edge.id}>
                <button type="button" onClick={() => selectEdgeFromList(edge)}>
                  {labelOf(edge.source)} → {labelOf(edge.target)} · {edge.kind}
                </button>
              </li>
            ))}
          </ul>
          {listed.total > listed.edges.length && (
            <p>
              Showing {listed.edges.length} of {listed.total} relationships.
              Type to narrow the list.
            </p>
          )}
        </details>
      </div>
      {layoutRunning && (
        <p className="graph-status" role="status">
          Laying out the graph in the background; positions refine until the
          layout converges.
        </p>
      )}
      <GraphViewport
        graph={graph}
        scope={scope}
        journey={journey}
        edgeFilter={filter}
        selectedEdgeId={selected?.id ?? null}
        focus={focus}
        apiRef={viewportApi}
        onNodeSelect={(node) => onOpenFile(node.path, node.startLine)}
        onEdgeSelect={selectEdge}
        onStageSelect={clearSelection}
        onLayoutRunning={setLayoutRunning}
      />
      {selected && (
        <div
          className="graph-evidence"
          role="region"
          aria-label="Relationship evidence"
        >
          <button
            onClick={() => setSelected(null)}
            aria-label="Close relationship evidence"
          >
            ×
          </button>
          <strong>
            {selected.kind} · {selected.confidence}
          </strong>
          {proofs.map((proof) => (
            <div key={proof.id}>
              <p>
                {proof.filePath}:{proof.startLine}
                {proof.endLine !== proof.startLine ? `–${proof.endLine}` : ""}
              </p>
              <pre>{proof.snippet}</pre>
              <button
                onClick={() => onOpenFile(proof.filePath, proof.startLine)}
              >
                Open source
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
