"use client";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Background,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CodeGraph, GraphEdge, GraphNode, Journey } from "@z1n/contracts";
import type { ViewportApi } from "./sigma-graph";

type Props = {
  graph: CodeGraph;
  mode: "journey" | "fallback";
  journey: Journey | null;
  edgeFilter: string;
  selectedEdgeId: string | null;
  onNodeSelect: (node: GraphNode) => void;
  onEdgeSelect: (edge: GraphEdge) => void;
  onStageSelect: () => void;
  onSubset: (subset: { shown: number; total: number } | null) => void;
  apiRef: RefObject<ViewportApi | null>;
};

// The WebGL fallback renders a bounded subset: beyond this many nodes the
// virtualized DOM canvas would itself degrade, so the least-connected
// symbols are dropped and the disclosure states the actual counts.
const FALLBACK_NODE_CAP = 1500;
const COMPACT_NODE_LIMIT = 150;
const LABELLED_EDGE_LIMIT = 400;
const isFile = (node: GraphNode) => !node.kind || node.kind === "file";

export function ReactFlowGraph({
  graph,
  mode,
  journey,
  edgeFilter,
  selectedEdgeId,
  onNodeSelect,
  onEdgeSelect,
  onStageSelect,
  onSubset,
  apiRef,
}: Props) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const flow = useRef<ReactFlowInstance | null>(null);
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );
  const files = useMemo(() => graph.nodes.filter(isFile), [graph]);
  const ordered = useMemo(() => {
    const symbols = new Map<string, GraphNode[]>();
    for (const node of graph.nodes)
      if (!isFile(node)) {
        const group = symbols.get(node.path);
        if (group) group.push(node);
        else symbols.set(node.path, [node]);
      }
    return files.flatMap((file) => [file, ...(symbols.get(file.path) ?? [])]);
  }, [graph, files]);
  const journeyNodes = useMemo(
    () => new Set(journey?.nodeIds ?? []),
    [journey],
  );
  const journeyEdges = useMemo(
    () => new Set(journey?.edgeIds ?? []),
    [journey],
  );
  const visibleNodes = useMemo(() => {
    if (mode === "journey")
      return (
        journey?.nodeIds
          .map((id) => byId.get(id))
          .filter((node) => node !== undefined) ?? []
      );
    // Fallback mode: files first, then symbols, bounded to the cap.
    return ordered.length <= FALLBACK_NODE_CAP
      ? ordered
      : ordered.slice(0, FALLBACK_NODE_CAP);
  }, [mode, journey, byId, ordered]);
  const visible = useMemo(() => {
    const ids = new Set(visibleNodes.map((node) => node.id));
    return graph.edges.filter(
      (edge) =>
        ids.has(edge.source) &&
        ids.has(edge.target) &&
        (mode !== "journey" || journeyEdges.has(edge.id)) &&
        (edgeFilter === "all" || edge.kind === edgeFilter),
    );
  }, [graph, edgeFilter, visibleNodes, mode, journeyEdges]);
  useEffect(() => {
    onSubset(
      mode === "fallback" && ordered.length > visibleNodes.length
        ? { shown: visibleNodes.length, total: ordered.length }
        : null,
    );
  }, [mode, ordered.length, visibleNodes.length, onSubset]);
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
  }, [visibleNodes]);
  const columns =
    visibleNodes.length <= COMPACT_NODE_LIMIT
      ? mobile
        ? 2
        : 5
      : Math.min(
          80,
          Math.max(5, Math.round(Math.sqrt(visibleNodes.length * 1.6))),
        );
  const labelled = visible.length <= LABELLED_EDGE_LIMIT;
  const labelOf = useMemo(
    () => (id: string) => byId.get(id)?.name ?? byId.get(id)?.path ?? id,
    [byId],
  );
  const nodes = useMemo<Node[]>(
    () =>
      visibleNodes.map((node, index) => ({
        id: node.id,
        position: {
          x: (index % columns) * 230,
          y: Math.floor(index / columns) * 130,
        },
        data: { label: node.name ? `${node.name} · ${node.path}` : node.path },
        ariaLabel: `${node.kind ?? "file"}: ${node.name ?? node.path}`,
        style: journeyNodes.has(node.id)
          ? { border: "3px solid #c2410c", background: "#fff7ed" }
          : undefined,
      })),
    [visibleNodes, columns, journeyNodes],
  );
  const edges = useMemo<Edge[]>(
    () =>
      visible.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: labelled ? edge.kind : undefined,
        ariaLabel: `${edge.kind} from ${labelOf(edge.source)} to ${labelOf(edge.target)}`,
        className: edge.id === selectedEdgeId ? "edge-selected" : undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: {
          stroke: journeyEdges.has(edge.id)
            ? "#c2410c"
            : edge.confidence === "heuristic"
              ? "#b45309"
              : "#2563eb",
          strokeWidth: journeyEdges.has(edge.id) ? 4 : 1.5,
          strokeDasharray: edge.confidence === "heuristic" ? "5 5" : undefined,
        },
      })),
    [visible, labelled, journeyEdges, labelOf, selectedEdgeId],
  );
  return (
    <ReactFlow
      onInit={(instance) => {
        flow.current = instance;
        apiRef.current = {
          zoomIn: () => void flow.current?.zoomIn({ duration: 200 }),
          zoomOut: () => void flow.current?.zoomOut({ duration: 200 }),
          resetView: () =>
            void flow.current?.fitView({
              padding: 0.15,
              minZoom: 0.65,
              maxZoom: 0.9,
              duration: 300,
            }),
          focusNode: (nodeId) => {
            const node = byId.get(nodeId);
            if (!node) return;
            const index = visibleNodes.findIndex((item) => item.id === nodeId);
            void flow.current?.setCenter(
              (index % columns) * 230,
              Math.floor(index / columns) * 130,
              { zoom: 0.9, duration: 400 },
            );
          },
        };
      }}
      forceColorMode="light"
      minZoom={visibleNodes.length <= COMPACT_NODE_LIMIT ? 0.65 : 0.05}
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
        if (item) onNodeSelect(item);
      }}
      onEdgeClick={(_, edge) => {
        const record = graph.edges.find((item) => item.id === edge.id);
        if (record) onEdgeSelect(record);
      }}
      onPaneClick={() => onStageSelect()}
      fitView
    >
      <Background />
    </ReactFlow>
  );
}
