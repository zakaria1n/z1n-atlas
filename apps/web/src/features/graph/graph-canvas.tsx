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
import type { CodeGraph, GraphEdge, GraphNode, Journey } from "@z1n/contracts";
import type { RepositorySession } from "@/features/repository-import/repository-session";
import { JourneyPanel } from "./journey-panel";

type Props = {
  graph: CodeGraph;
  session: RepositorySession;
  onOpenFile: (path: string, line?: number) => void;
};
// Up to these sizes a graph stays readable with every edge labelled and the
// whole relationship list available. Beyond them, labels and the list are
// narrowed because a large selection would otherwise mount tens of thousands
// of elements that no one can read.
const LABELLED_EDGE_LIMIT = 400;
const COMPACT_NODE_LIMIT = 150;
const RELATIONSHIP_PAGE = 100;
const isFile = (node: GraphNode) => !node.kind || node.kind === "file";

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
  const [view, setView] = useState<"files" | "all" | "journey">("files");
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
  const [relationshipQuery, setRelationshipQuery] = useState("");
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );
  // Files in path order, each followed by the symbols declared in it, so that
  // a file and its symbols are neighbours on the grid and their edges short.
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
  const visibleNodes = useMemo(
    () =>
      view === "files"
        ? files
        : view === "journey"
          ? (journey?.nodeIds
              .map((id) => byId.get(id))
              .filter((node) => node !== undefined) ?? [])
          : ordered,
    [files, ordered, view, journey, byId],
  );
  const visible = useMemo(() => {
    const ids = new Set(visibleNodes.map((node) => node.id));
    return graph.edges.filter(
      (edge) =>
        ids.has(edge.source) &&
        ids.has(edge.target) &&
        (view !== "journey" || journeyEdges.has(edge.id)) &&
        (filter === "all" || edge.kind === filter),
    );
  }, [graph, filter, visibleNodes, view, journeyEdges]);
  // A dense grid keeps large graphs from becoming an extremely tall column.
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
  const labelOf = useMemo(() => {
    const label = (id: string) =>
      byId.get(id)?.name ?? byId.get(id)?.path ?? id;
    return label;
  }, [byId]);
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
    [visible, labelled, journeyEdges, labelOf],
  );
  const listed = useMemo(() => {
    const needle = relationshipQuery.trim().toLowerCase();
    const matches = needle
      ? visible.filter((edge) =>
          `${labelOf(edge.source)} ${labelOf(edge.target)} ${edge.kind}`
            .toLowerCase()
            .includes(needle),
        )
      : visible;
    return {
      edges: matches.slice(0, RELATIONSHIP_PAGE),
      total: matches.length,
    };
  }, [visible, relationshipQuery, labelOf]);
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
        {session.inventory &&
          session.inventory.length > session.files.length && (
            <span>
              Analyzing {session.files.length} of {session.inventory.length}{" "}
              indexed files; coverage is partial.
            </span>
          )}
        {!labelled && (
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
              if (value.nodeIds.length) setView("journey");
            } else if (view === "journey") setView("files");
          }}
          onOpenFile={onOpenFile}
        />
        <label htmlFor="graph-scope">Graph scope</label>
        <select
          id="graph-scope"
          value={view}
          onChange={(event) => {
            setView(event.target.value as "files" | "all" | "journey");
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
          <summary>Inspect relationships ({visible.length})</summary>
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
                <button type="button" onClick={() => setSelected(edge)}>
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
      <ReactFlow
        onInit={(instance) => {
          flow.current = instance;
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
