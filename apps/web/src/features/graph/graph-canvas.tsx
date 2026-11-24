"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CodeGraph, GraphEdge } from "@z1n/contracts";

type Props = {
  graph: CodeGraph;
  onOpenFile: (path: string, line?: number) => void;
};
export function GraphCanvas({ graph, onOpenFile }: Props) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<GraphEdge | null>(null);
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );
  const visible = useMemo(
    () =>
      graph.edges.filter((edge) => filter === "all" || edge.kind === filter),
    [graph, filter],
  );
  const nodes = useMemo<Node[]>(
    () =>
      graph.nodes.map((node, index) => ({
        id: node.id,
        position: {
          x: (index % (mobile ? 2 : 5)) * 230,
          y: Math.floor(index / (mobile ? 2 : 5)) * 130,
        },
        data: { label: node.name ? `${node.name} · ${node.path}` : node.path },
        ariaLabel: `${node.kind ?? "file"}: ${node.name ?? node.path}`,
      })),
    [graph, mobile],
  );
  const edges = useMemo<Edge[]>(
    () =>
      visible.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.kind,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: {
          stroke: edge.confidence === "heuristic" ? "#b45309" : "#2563eb",
          strokeDasharray: edge.confidence === "heuristic" ? "5 5" : undefined,
        },
      })),
    [visible],
  );
  const proofs = selected
    ? [selected.evidenceId, ...(selected.supportingEvidenceIds ?? [])]
        .map((id) => graph.evidence.find((item) => item.id === id))
        .filter((item) => item !== undefined)
    : [];
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
            setSelected(item);
          }
        }
      }}
    >
      <div className="graph-info">
        <strong>Source relationships</strong>
        <span>Solid: static or framework · dashed: heuristic</span>
        <span>
          {graph.unresolved} unresolved imports or routes ·{" "}
          {graph.unresolvedCalls} unresolved calls
        </span>
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
          <summary>Inspect relationships ({visible.length})</summary>
          <ul className="relations">
            {visible.map((edge) => (
              <li key={edge.id}>
                <button type="button" onClick={() => setSelected(edge)}>
                  {byId.get(edge.source)?.name ?? byId.get(edge.source)?.path} →{" "}
                  {byId.get(edge.target)?.name ?? byId.get(edge.target)?.path} ·{" "}
                  {edge.kind}
                </button>
              </li>
            ))}
          </ul>
        </details>
      </div>
      <ReactFlow
        forceColorMode="light"
        minZoom={0.65}
        maxZoom={1.8}
        fitViewOptions={{ minZoom: 0.65, maxZoom: 0.9, padding: 0.15 }}
        nodes={nodes}
        edges={edges}
        deleteKeyCode={null}
        ariaLabelConfig={{
          "node.a11yDescription.default": "Press Enter to open source.",
          "node.a11yDescription.keyboardDisabled":
            "Select a node to open source.",
          "edge.a11yDescription.default": "Press Enter to inspect evidence.",
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        onlyRenderVisibleElements
        onNodeClick={(_, node) => {
          const item = byId.get(node.id);
          if (item) onOpenFile(item.path, item.startLine);
        }}
        onEdgeClick={(_, edge) =>
          setSelected(graph.edges.find((item) => item.id === edge.id) ?? null)
        }
        fitView
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
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
