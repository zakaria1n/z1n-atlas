"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CodeGraph, GraphEdge, Journey } from "@z1n/contracts";
import type { RepositorySession } from "@/features/repository-import/repository-session";
import { JourneyPanel } from "./journey-panel";

type Props = {
  graph: CodeGraph;
  session: RepositorySession;
  onOpenFile: (path: string, line?: number) => void;
};
export function GraphCanvas({ graph, session, onOpenFile }: Props) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState<"files" | "all">("files");
  const flow = useRef<ReactFlowInstance | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void flow.current?.fitView({
        padding: 0.15,
        minZoom: 0.65,
        maxZoom: 0.9,
        duration: 0,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);
  const [selected, setSelected] = useState<GraphEdge | null>(null);
  const [journey, setJourney] = useState<Journey | null>(null);
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );
  const visibleNodes = useMemo(
    () =>
      view === "files"
        ? graph.nodes.filter((node) => !node.kind || node.kind === "file")
        : graph.nodes,
    [graph, view],
  );
  const visible = useMemo(() => {
    const ids = new Set(visibleNodes.map((node) => node.id));
    return graph.edges.filter(
      (edge) =>
        ids.has(edge.source) &&
        ids.has(edge.target) &&
        (filter === "all" || edge.kind === filter),
    );
  }, [graph, filter, visibleNodes]);
  const nodes = useMemo<Node[]>(
    () =>
      visibleNodes.map((node, index) => ({
        id: node.id,
        position: {
          x: (index % (mobile ? 2 : 5)) * 230,
          y: Math.floor(index / (mobile ? 2 : 5)) * 130,
        },
        data: { label: node.name ? `${node.name} · ${node.path}` : node.path },
        ariaLabel: `${node.kind ?? "file"}: ${node.name ?? node.path}`,
        style: journey?.nodeIds.includes(node.id)
          ? { border: "3px solid #c2410c", background: "#fff7ed" }
          : undefined,
      })),
    [visibleNodes, mobile, journey],
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
          stroke: journey?.edgeIds.includes(edge.id)
            ? "#c2410c"
            : edge.confidence === "heuristic"
              ? "#b45309"
              : "#2563eb",
          strokeWidth: journey?.edgeIds.includes(edge.id) ? 4 : 1.5,
          strokeDasharray: edge.confidence === "heuristic" ? "5 5" : undefined,
        },
      })),
    [visible, journey],
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
        <JourneyPanel
          session={session}
          graph={graph}
          journey={journey}
          onJourney={(value) => {
            setJourney(value);
            if (value) {
              setFilter("all");
              setView("all");
            }
          }}
          onOpenFile={onOpenFile}
        />
        <label htmlFor="graph-scope">Graph scope</label>
        <select
          id="graph-scope"
          value={view}
          onChange={(event) => {
            setView(event.target.value as "files" | "all");
            setJourney(null);
          }}
        >
          <option value="files">Files</option>
          <option value="all">Files and symbols</option>
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
        onInit={(instance) => {
          flow.current = instance;
        }}
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
