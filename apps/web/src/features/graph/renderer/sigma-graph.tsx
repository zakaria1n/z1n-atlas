"use client";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { CodeGraph, GraphEdge, GraphNode, Journey } from "@z1n/contracts";
import {
  EDGE_COLOR,
  HEURISTIC_EDGE_COLOR,
  JOURNEY_COLOR,
  codeGraphToGraphology,
  mixWithBackground,
  type GraphologyGraph,
} from "./adapter";
import { curvedEdgePath } from "./edge-paths";
import { fa2Settings } from "./fa2-settings";
import { createFa2Supervisor, type Fa2WorkerLike } from "./use-fa2-layout";
import { webglAvailable } from "./webgl";

export type ViewportApi = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  focusNode: (nodeId: string) => void;
};

type Props = {
  graph: CodeGraph;
  scope: "files" | "all";
  journey: Journey | null;
  edgeFilter: string;
  selectedEdgeId: string | null;
  focus: { nodeId: string; nonce: number } | null;
  apiRef: RefObject<ViewportApi | null>;
  onNodeSelect: (node: GraphNode) => void;
  onEdgeSelect: (edge: GraphEdge) => void;
  onStageSelect: () => void;
  onUnavailable: () => void;
  onLayoutRunning: (running: boolean) => void;
};

// Layout budgets by graph size: refinement continues in the background while
// the renderer stays interactive, and the worker is always terminated at the
// budget, on replacement and on unmount.
function layoutBudget(nodeCount: number): number {
  if (nodeCount < 1000) return 6_000;
  if (nodeCount < 5000) return 12_000;
  return 20_000;
}

function workerFactory(): Fa2WorkerLike {
  // The DOM Worker type's overloaded postMessage is structurally stricter
  // than the supervisor's single-message protocol; the runtime contract is
  // exactly the message set declared in fa2.worker.ts.
  return new Worker(
    new URL("./fa2.worker.ts", import.meta.url),
  ) as unknown as Fa2WorkerLike;
}

type CameraState = {
  x: number;
  y: number;
  ratio: number;
};

// Minimal structural view of the sigma instance used by this component; the
// concrete generic instance type depends on the declared primitives and is
// not worth modeling beyond the calls made here.
type SigmaLike = {
  refresh: (options?: Record<string, unknown>) => unknown;
  setGraph: (graph: GraphologyGraph) => unknown;
  getCamera: () => {
    zoomIn: (options?: { duration?: number }) => Promise<void>;
    zoomOut: (options?: { duration?: number }) => Promise<void>;
    reset: (options?: { duration?: number }) => Promise<void>;
    animate: (
      state: Partial<CameraState>,
      options?: { duration?: number },
    ) => Promise<void>;
    getState: () => CameraState;
  };
  on: (
    event:
      | "clickNode"
      | "clickEdge"
      | "clickStage"
      | "enterNode"
      | "leaveNode"
      | "webglContextLost"
      | "afterRender",
    handler: (payload: { node?: string; edge?: string }) => void,
  ) => unknown;
  kill: () => void;
};

export function SigmaGraph({
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
  onUnavailable,
  onLayoutRunning,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<SigmaLike | null>(null);
  const layoutRef = useRef<GraphologyGraph | null>(null);
  const supervisorRef = useRef<ReturnType<typeof createFa2Supervisor> | null>(
    null,
  );
  const frameRef = useRef<number | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);

  // Renderer inputs are read through refs by the sigma reducers, so filters,
  // journey highlighting and selection refresh the frame without ever
  // rebuilding the graphology graph or the sigma instance.
  const inputs = useMemo(
    () => ({
      nodesById: new Map(graph.nodes.map((node) => [node.id, node])),
      edgesById: new Map(graph.edges.map((edge) => [edge.id, edge])),
    }),
    [graph],
  );
  const scopeRef = useRef(scope);
  const edgeFilterRef = useRef(edgeFilter);
  const selectedRef = useRef(selectedEdgeId);
  const journeyRef = useRef<{ nodes: Set<string>; edges: Set<string> } | null>(
    journey && journey.nodeIds.length
      ? { nodes: new Set(journey.nodeIds), edges: new Set(journey.edgeIds) }
      : null,
  );
  const callbackRef = useRef({ onNodeSelect, onEdgeSelect, onStageSelect });
  const unavailableRef = useRef(onUnavailable);
  const layoutRunningRef = useRef(onLayoutRunning);

  // Reducer inputs and callbacks are kept fresh through effects so the sigma
  // instance created once per graph always reads current values without
  // being rebuilt.
  useEffect(() => {
    callbackRef.current = { onNodeSelect, onEdgeSelect, onStageSelect };
    unavailableRef.current = onUnavailable;
    layoutRunningRef.current = onLayoutRunning;
  }, [
    onNodeSelect,
    onEdgeSelect,
    onStageSelect,
    onUnavailable,
    onLayoutRunning,
  ]);

  useEffect(() => {
    scopeRef.current = scope;
    edgeFilterRef.current = edgeFilter;
    selectedRef.current = selectedEdgeId;
    journeyRef.current =
      journey && journey.nodeIds.length
        ? { nodes: new Set(journey.nodeIds), edges: new Set(journey.edgeIds) }
        : null;
    sigmaRef.current?.refresh();
  }, [scope, journey, edgeFilter, selectedEdgeId]);

  const applyPositions = (ids: string[], positions: Float32Array) => {
    const layout = layoutRef.current;
    if (!layout) return;
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]!;
      if (!layout.hasNode(id)) continue;
      layout.setNodeAttribute(id, "x", positions[index * 2]!);
      layout.setNodeAttribute(id, "y", positions[index * 2 + 1]!);
    }
    if (frameRef.current === null)
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        sigmaRef.current?.refresh();
      });
  };

  const launchRef = useRef<((layout: GraphologyGraph) => void) | null>(null);
  useEffect(() => {
    launchRef.current = (layout: GraphologyGraph) => {
      const sigma = sigmaRef.current;
      const supervisor = supervisorRef.current;
      if (!sigma || !supervisor) return;
      supervisor.kill();
      void (async () => {
        const { default: forceAtlas2 } =
          await import("graphology-layout-forceatlas2");
        if (layoutRef.current !== layout) return;
        forceAtlas2.assign(layout, {
          iterations: layout.order > 2000 ? 10 : 30,
          settings: fa2Settings(layout.order),
        });
        if (sigmaRef.current !== sigma) return;
        sigma.setGraph(layout);
        sigma.getCamera().reset({ duration: 200 });
        sigma.refresh();
        layoutRunningRef.current(true);
        const ids = layout.nodes();
        const indexOf = new Map(ids.map((id, index) => [id, index]));
        const positions = new Float32Array(layout.order * 2);
        const sizes = new Float32Array(layout.order);
        ids.forEach((id, index) => {
          const attributes = layout.getNodeAttributes(id);
          positions[index * 2] = attributes.x;
          positions[index * 2 + 1] = attributes.y;
          sizes[index] = attributes.size;
        });
        const edges = new Uint32Array(layout.size * 2);
        let cursor = 0;
        layout.forEachEdge((edge) => {
          const [source, target] = layout.extremities(edge);
          edges[cursor++] = indexOf.get(source) ?? 0;
          edges[cursor++] = indexOf.get(target) ?? 0;
        });
        supervisor.start(
          {
            ids,
            edges,
            positions,
            sizes,
            settings: fa2Settings(layout.order),
            budgetMs: layoutBudget(layout.order),
            chunkIterations: 8,
          },
          {
            onTick: (fresh) => applyPositions(ids, fresh),
            onDone: () => {
              layoutRunningRef.current(false);
              sigmaRef.current?.refresh();
              sigma.getCamera().reset({ duration: 400 });
            },
          },
        );
      })();
    };
  }, []);

  useEffect(() => {
    // Strict-mode double mount safety: each effect run owns its renderer and
    // aborts itself when superseded, so exactly one sigma instance survives.
    let disposed = false;
    const startedAt = performance.now();
    const supervisor = createFa2Supervisor({ createWorker: workerFactory });
    supervisorRef.current = supervisor;
    let rendered = false;
    (async () => {
      try {
        if (!webglAvailable()) {
          if (!disposed) unavailableRef.current();
          return;
        }
        const { default: SigmaConstructor, DEFAULT_STYLES } =
          await import("sigma");
        if (disposed || !container.current) return;
        const layout = codeGraphToGraphology(graph);
        layoutRef.current = layout;
        // A short synchronous seed spreads the deterministic starting
        // positions so the first frame is already readable.
        const { default: forceAtlas2 } =
          await import("graphology-layout-forceatlas2");
        forceAtlas2.assign(layout, {
          iterations: layout.order > 2000 ? 10 : 30,
          settings: fa2Settings(layout.order),
        });
        if (disposed) return;
        const sigma = new SigmaConstructor(layout, container.current, {
          primitives: { edges: { paths: [curvedEdgePath()] } },
          settings: {
            renderEdgeLabels: false,
            enableEdgeEvents: true,
            hideEdgesOnMove: true,
            labelDensity: 0.5,
            labelGridCellSize: 100,
            labelRenderedSizeThreshold: 7,
            minCameraRatio: 0.02,
            maxCameraRatio: 8,
          },
          styles: {
            // The styles declaration replaces the defaults wholesale, so the
            // attribute bindings (color, label, size) must be kept.
            nodes: {
              ...DEFAULT_STYLES.nodes,
              labelColor: "#0f172a",
              labelSize: 12,
            },
            edges: { ...DEFAULT_STYLES.edges, labelColor: "#0f172a" },
          },
          nodeReducer: (node, data, attributes) => {
            const res = { ...data };
            if (scopeRef.current === "files" && attributes.kind !== "file") {
              res.visibility = "hidden";
              return res;
            }
            const journeyActive = journeyRef.current;
            if (journeyActive) {
              if (journeyActive.nodes.has(node)) {
                res.color = JOURNEY_COLOR;
                res.size = (data.size ?? 3) * 1.6;
                res.highlighted = true;
                res.zIndex = 2;
              } else {
                res.color = mixWithBackground(data.color ?? "#2563eb", 0.78);
                res.size = (data.size ?? 3) * 0.5;
              }
              return res;
            }
            const selected = selectedRef.current;
            const selectedEdge = selected
              ? inputs.edgesById.get(selected)
              : null;
            if (
              selectedEdge &&
              (selectedEdge.source === node || selectedEdge.target === node)
            ) {
              res.size = (data.size ?? 3) * 1.7;
              res.highlighted = true;
              res.zIndex = 2;
            }
            return res;
          },
          edgeReducer: (
            edge,
            data,
            attributes,
            _state,
            _graphState,
            layout,
          ) => {
            const res = { ...data };
            if (
              edgeFilterRef.current !== "all" &&
              attributes.kind !== edgeFilterRef.current
            ) {
              res.visibility = "hidden";
              return res;
            }
            if (scopeRef.current === "files") {
              const [source, target] = layout.extremities(edge);
              if (
                layout.getNodeAttribute(source, "kind") !== "file" ||
                layout.getNodeAttribute(target, "kind") !== "file"
              ) {
                res.visibility = "hidden";
                return res;
              }
            }
            const journeyActive = journeyRef.current;
            if (journeyActive) {
              if (journeyActive.edges.has(edge)) {
                res.color = JOURNEY_COLOR;
                res.size = Math.max(2, (data.size ?? 1) * 3);
                res.zIndex = 2;
              } else {
                res.color = mixWithBackground(
                  attributes.confidence === "heuristic"
                    ? HEURISTIC_EDGE_COLOR
                    : EDGE_COLOR,
                  0.88,
                );
                res.size = 0.3;
              }
              return res;
            }
            const selected = selectedRef.current;
            if (selected) {
              const selectedEdge = inputs.edgesById.get(selected);
              const [source, target] = layout.extremities(edge);
              const connected =
                selectedEdge &&
                (selectedEdge.source === source ||
                  selectedEdge.source === target ||
                  selectedEdge.target === source ||
                  selectedEdge.target === target);
              if (edge === selected) {
                res.color = "#174eb5";
                res.size = Math.max(2.5, (data.size ?? 1) * 3.5);
                res.zIndex = 2;
              } else if (connected) {
                res.color = mixWithBackground(data.color ?? "#2563eb", 0.2);
                res.size = Math.max(1.5, (data.size ?? 1) * 2);
                res.zIndex = 1;
              } else {
                res.color = mixWithBackground(
                  attributes.confidence === "heuristic"
                    ? HEURISTIC_EDGE_COLOR
                    : EDGE_COLOR,
                  0.85,
                );
                res.size = 0.3;
              }
              return res;
            }
            // No selection or journey: heuristic confidence keeps the amber
            // identity color, everything else cobalt.
            res.color =
              attributes.confidence === "heuristic"
                ? HEURISTIC_EDGE_COLOR
                : EDGE_COLOR;
            return res;
          },
        });
        sigmaRef.current = sigma;
        apiRef.current = {
          zoomIn: () => sigma.getCamera().zoomIn({ duration: 200 }),
          zoomOut: () => sigma.getCamera().zoomOut({ duration: 200 }),
          resetView: () => sigma.getCamera().reset({ duration: 300 }),
          focusNode: (nodeId) => {
            const layout = layoutRef.current;
            if (!layout?.hasNode(nodeId)) return;
            const attributes = layout.getNodeAttributes(nodeId);
            sigma
              .getCamera()
              .animate(
                { x: attributes.x, y: attributes.y, ratio: 0.25 },
                { duration: 400 },
              );
          },
        };
        sigma.on("clickNode", ({ node }) => {
          const record = inputs.nodesById.get(node);
          if (record) callbackRef.current.onNodeSelect(record);
        });
        sigma.on("clickEdge", ({ edge }) => {
          const record = inputs.edgesById.get(edge);
          if (record) callbackRef.current.onEdgeSelect(record);
        });
        sigma.on("clickStage", () => callbackRef.current.onStageSelect());
        sigma.on("enterNode", () => {
          if (container.current) container.current.style.cursor = "pointer";
        });
        sigma.on("leaveNode", () => {
          if (container.current) container.current.style.cursor = "grab";
        });
        sigma.on("webglContextLost", () => unavailableRef.current());
        sigma.on("afterRender", () => {
          if (rendered) return;
          rendered = true;
          if (process.env.NODE_ENV !== "production") {
            // Dev-only hooks for the renderer benchmark and interaction
            // tests; production builds never include this surface.
            const hooks = window as unknown as Record<string, unknown>;
            if (new URLSearchParams(window.location.search).has("bench"))
              hooks.__z1nGraphMetrics = {
                renderer: "sigma",
                ttfrMs: Math.round(performance.now() - startedAt),
                nodes: layout.order,
                edges: layout.size,
              };
            hooks.__z1nGraphApi = {
              nodeIds: () => layout.nodes(),
              nodeDisplayData: (id: string) => sigma.getNodeDisplayData(id),
              nodeAttributes: (id: string) => layout.getNodeAttributes(id),
              nodeViewportPosition: (id: string) => {
                const attributes = layout.getNodeAttributes(id);
                return sigma.graphToViewport({
                  x: attributes.x,
                  y: attributes.y,
                });
              },
            };
          }
        });
        disposeRef.current = () => {
          sigma.kill();
          apiRef.current = null;
          const hooks = window as unknown as Record<string, unknown>;
          delete hooks.__z1nGraphMetrics;
          delete hooks.__z1nGraphApi;
          if (container.current) container.current.replaceChildren();
        };
        if (disposed) {
          disposeRef.current();
          disposeRef.current = null;
          return;
        }
        launchRef.current?.(layout);
      } catch (error) {
        if (!disposed) {
          console.error(
            "Sigma renderer failed; using the React Flow fallback.",
            error,
          );
          unavailableRef.current();
        }
      }
    })();
    return () => {
      disposed = true;
      supervisorRef.current?.kill();
      supervisorRef.current = null;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      disposeRef.current?.();
      disposeRef.current = null;
      sigmaRef.current = null;
      layoutRef.current = null;
    };
    // The renderer mounts once per graph; graph replacement is handled by
    // launchRef through the identity effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    if (focus) apiRef.current?.focusNode(focus.nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  return (
    <div
      className="sigma-stage"
      ref={container}
      role="application"
      aria-label="Interactive source relationship graph. Keyboard: plus, minus and zero zoom; arrow keys pan; use the relationship list for keyboard-accessible selection."
      tabIndex={0}
      onKeyDown={(event) => {
        const current = sigmaRef.current;
        if (!current) return;
        const state = current.getCamera().getState() as CameraState;
        const pan = 0.12 * Math.max(state.ratio, 0.02);
        if (event.key === "+") current.getCamera().zoomIn({ duration: 120 });
        else if (event.key === "-")
          current.getCamera().zoomOut({ duration: 120 });
        else if (event.key === "0")
          current.getCamera().reset({ duration: 200 });
        else if (event.key.startsWith("Arrow")) {
          event.preventDefault();
          current.getCamera().animate(
            {
              x:
                state.x +
                (event.key === "ArrowLeft"
                  ? -pan
                  : event.key === "ArrowRight"
                    ? pan
                    : 0),
              y:
                state.y +
                (event.key === "ArrowUp"
                  ? pan
                  : event.key === "ArrowDown"
                    ? -pan
                    : 0),
            },
            { duration: 120 },
          );
        }
      }}
    />
  );
}
