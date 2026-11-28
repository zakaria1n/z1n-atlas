"use client";
import { useCallback, useEffect, useState, type RefObject } from "react";
import type { CodeGraph, GraphEdge, GraphNode, Journey } from "@z1n/contracts";
import { ReactFlowGraph } from "./renderer/react-flow-graph";
import { SigmaGraph, type ViewportApi } from "./renderer/sigma-graph";
import { webglAvailable } from "./renderer/webgl";

export type GraphScope = "files" | "all" | "journey";

type Props = {
  graph: CodeGraph;
  scope: GraphScope;
  journey: Journey | null;
  edgeFilter: string;
  selectedEdgeId: string | null;
  focus: { nodeId: string; nonce: number } | null;
  apiRef: RefObject<ViewportApi | null>;
  onNodeSelect: (node: GraphNode) => void;
  onEdgeSelect: (edge: GraphEdge) => void;
  onStageSelect: () => void;
  onLayoutRunning: (running: boolean) => void;
};

/**
 * Renderer dispatcher for the workspace graph. The Feature Journey scope
 * keeps the focused React Flow diagram; the repository-wide scopes render
 * with Sigma.js and fall back to a disclosed bounded React Flow subset when
 * WebGL is unavailable, initialization fails, or the context is lost.
 */
export function GraphViewport({
  graph,
  scope,
  journey,
  edgeFilter,
  selectedEdgeId,
  focus,
  apiRef,
  onNodeSelect,
  onEdgeSelect,
  onStageSelect,
  onLayoutRunning,
}: Props) {
  const [capability, setCapability] = useState<
    "pending" | "available" | "unavailable"
  >("pending");
  const [subset, setSubset] = useState<{ shown: number; total: number } | null>(
    null,
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      setCapability(webglAvailable() ? "available" : "unavailable"),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  const onUnavailable = useCallback(() => setCapability("unavailable"), []);
  const onSubset = useCallback(
    (value: { shown: number; total: number } | null) => setSubset(value),
    [],
  );

  const zoomCluster = (
    <div className="graph-zoom">
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => apiRef.current?.zoomIn()}
      >
        +
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        onClick={() => apiRef.current?.zoomOut()}
      >
        −
      </button>
      <button
        type="button"
        aria-label="Reset view"
        onClick={() => apiRef.current?.resetView()}
      >
        ⤾
      </button>
    </div>
  );

  if (scope === "journey")
    return (
      <>
        <div className="graph-stage" data-renderer="react-flow">
          <ReactFlowGraph
            graph={graph}
            mode="journey"
            journey={journey}
            edgeFilter={edgeFilter}
            selectedEdgeId={selectedEdgeId}
            onNodeSelect={onNodeSelect}
            onEdgeSelect={onEdgeSelect}
            onStageSelect={onStageSelect}
            onSubset={() => {}}
            apiRef={apiRef}
          />
        </div>
        {zoomCluster}
        <p className="graph-status" role="status">
          The journey scope renders the focused React Flow diagram; the full
          repository graph uses the Sigma renderer.
        </p>
      </>
    );

  if (capability === "unavailable")
    return (
      <>
        <div className="graph-stage" data-renderer="react-flow">
          <ReactFlowGraph
            graph={graph}
            mode="fallback"
            journey={journey}
            edgeFilter={edgeFilter}
            selectedEdgeId={selectedEdgeId}
            onNodeSelect={onNodeSelect}
            onEdgeSelect={onEdgeSelect}
            onStageSelect={onStageSelect}
            onSubset={onSubset}
            apiRef={apiRef}
          />
        </div>
        {zoomCluster}
        <p className="graph-status" role="status">
          WebGL is unavailable, so the graph renders as a bounded subset
          {subset
            ? `: ${subset.shown} of ${subset.total} analyzed elements.`
            : "."}{" "}
          Source inspection, AI Chat and Feature Journey remain fully available.
        </p>
      </>
    );

  if (capability === "pending")
    return (
      <p className="graph-status" role="status">
        Preparing the graph renderer…
      </p>
    );

  return (
    <>
      <div className="graph-stage" data-renderer="sigma">
        <SigmaGraph
          graph={graph}
          scope={scope}
          journey={journey}
          edgeFilter={edgeFilter}
          selectedEdgeId={selectedEdgeId}
          focus={focus}
          apiRef={apiRef}
          onNodeSelect={onNodeSelect}
          onEdgeSelect={onEdgeSelect}
          onStageSelect={onStageSelect}
          onUnavailable={onUnavailable}
          onLayoutRunning={onLayoutRunning}
        />
      </div>
      {zoomCluster}
    </>
  );
}
