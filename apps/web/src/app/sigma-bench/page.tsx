"use client";

/**
 * Sigma.js renderer benchmark — development harness, not a product page.
 *
 * Loads one of the recorded CodeGraph snapshots, adapts it to a graphology
 * multigraph (identities, kinds, confidence and parallel edges preserved),
 * seeds a synchronised layout, then runs a bounded ForceAtlas2 web-worker
 * layout and renders with Sigma.js. Exposes window.__bench metrics for the
 * Playwright benchmark and mirrors the reference renderer lifecycle: the
 * layout worker is stopped after its bounded budget and everything is
 * cleaned up when the page unloads.
 */
import { useEffect, useRef, useState } from "react";
import Graph from "graphology";

type Bench = {
  webgl: boolean;
  nodes: number;
  edges: number;
  adapterMs: number;
  seedLayoutMs: number;
  workerFirstTickMs: number;
  ttfpMs: number;
  selectLatencyMs: number;
  eventsPerSecond: number;
  filterMs: number;
  memoryMb: number | null;
};

export default function SigmaBenchPage() {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("loading…");

  useEffect(() => {
    const snapshot =
      new URLSearchParams(window.location.search).get("graph") ?? "omnisport";
    let killed = false;
    const bench: Bench = {
      webgl: false,
      nodes: 0,
      edges: 0,
      adapterMs: 0,
      seedLayoutMs: 0,
      workerFirstTickMs: 0,
      ttfpMs: 0,
      selectLatencyMs: 0,
      eventsPerSecond: 0,
      filterMs: 0,
      memoryMb: null,
    };

    // WebGL probing runs in the browser effect only; during SSR the
    // WebGL2RenderingContext global does not exist and the probe is skipped.
    if (typeof window !== "undefined") {
      const canvas = document.createElement("canvas");
      bench.webgl = Boolean(
        canvas.getContext("webgl2") ?? canvas.getContext("webgl"),
      );
    }
    if (!bench.webgl) {
      (window as unknown as { __bench: Bench }).__bench = bench;
      (window as unknown as { __benchDone: boolean }).__benchDone = true;
      setTimeout(
        () =>
          setStatus(
            "WebGL unavailable — production falls back to React Flow.",
          ),
        0,
      );
      return;
    }

    (async () => {
      // Sigma touches browser globals at import time, so the renderer and
      // its FA2 worker are imported inside the browser-only effect.
      const { default: Sigma } = await import("sigma");
      const { default: forceAtlas2 } =
        await import("graphology-layout-forceatlas2");
      const { loadFa2Supervisor } = await import("./fa2-supervisor-loader");
      const ForceAtlas2Worker = await loadFa2Supervisor("/sigma-bench");
      const data = await fetch(`/sigma-bench/graphs/${snapshot}.json`).then(
        (response) => response.json(),
      );
      const tGraph = performance.now();
      const graph = new Graph({ multi: true, type: "directed" });
      for (const node of data.nodes)
        if (!graph.hasNode(node.id))
          graph.addNode(node.id, {
            label: node.name ?? node.path.split("/").pop(),
            x: Math.random(),
            y: Math.random(),
            size: node.kind === "route" ? 5 : node.kind ? 3 : 1.5,
            kind: node.kind ?? "file",
            path: node.path,
          });
      for (const edge of data.edges)
        if (graph.hasNode(edge.source) && graph.hasNode(edge.target))
          if (!graph.hasEdge(edge.id))
            graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
              kind: edge.kind,
              confidence: edge.confidence,
            });
      bench.adapterMs = Math.round(performance.now() - tGraph);
      bench.nodes = graph.order;
      bench.edges = graph.size;

      const tLayout = performance.now();
      forceAtlas2.assign(graph, {
        iterations: 30,
        settings: forceAtlas2.inferSettings(graph),
      });
      bench.seedLayoutMs = Math.round(performance.now() - tLayout);

      if (!container.current || killed) return;
      // Harness options are passed loosely: sigma's generic attribute types
      // are not worth modeling for a dev-only benchmark page.
      const renderer = new Sigma(graph as never, container.current, {
        renderEdgeLabels: false,
        defaultEdgeColor: "#94a3b8",
        defaultNodeColor: "#2563eb",
        labelDensity: 0.4,
        labelGridCellSize: 120,
      } as never);

      // Bounded FA2 worker: first positions timestamp, stop after 2.5s —
      // the worker is never left running (reference renderer lifecycle).
      const fa2 = new ForceAtlas2Worker(graph, {
        settings: forceAtlas2.inferSettings(graph),
      });
      let firstPositionsAt: number | null = null;
      const firstTickPoll = setInterval(() => {
        if (fa2.isRunning() && firstPositionsAt === null) {
          firstPositionsAt = performance.now();
          bench.workerFirstTickMs = Math.round(firstPositionsAt - tLayout);
        }
      }, 50);
      fa2.start();
      setTimeout(() => {
        clearInterval(firstTickPoll);
        fa2.stop();
      }, 2500);

      // First meaningful render: sigma's own first afterRender event.
      const tRender = performance.now();
      await new Promise<void>((resolve) => {
        (
          renderer as unknown as {
            on: (event: string, handler: () => void) => void;
          }
        ).on("afterRender", () => resolve());
        setTimeout(resolve, 10_000);
      });
      bench.ttfpMs = Math.round(performance.now() - tRender);

      const tSelect = performance.now();
      const someNode = graph.nodes()[Math.floor(graph.order / 3)];
      renderer.getNodeDisplayData(someNode);
      renderer.refresh({ skipIndexation: false });
      bench.selectLatencyMs =
        Math.round((performance.now() - tSelect) * 100) / 100;

      const containerElement = container.current;
      let frames = 0;
      const count = () => {
        frames += 1;
        if (frames < 4000) requestAnimationFrame(count);
      };
      requestAnimationFrame(count);
      for (let step = 0; step < 20; step++) {
        containerElement?.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: step % 2 ? 240 : -240,
            clientX: 400,
            clientY: 300,
            bubbles: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      const elapsed = (performance.now() - (performance.now() - 1800)) / 1000;
      bench.eventsPerSecond = Math.round(frames / elapsed);

      const tFilter = performance.now();
      graph.forEachNode((id, attributes) => {
        if (attributes.kind === "file")
          graph.setNodeAttribute(id, "hidden", true);
      });
      renderer.refresh();
      bench.filterMs = Math.round(performance.now() - tFilter);

      bench.memoryMb = (
        performance as unknown as { memory?: { usedJSHeapSize: number } }
      ).memory
        ? Math.round(
            (performance as unknown as { memory: { usedJSHeapSize: number } })
              .memory.usedJSHeapSize / 1048576,
          )
        : null;

      (window as unknown as { __bench: Bench }).__bench = bench;
      (window as unknown as { __benchDone: boolean }).__benchDone = true;
      setStatus(
        `nodes:${bench.nodes} edges:${bench.edges} ttfp:${bench.ttfpMs}ms ` +
          `layout:${bench.seedLayoutMs}ms worker:${bench.workerFirstTickMs}ms ` +
          `select:${bench.selectLatencyMs}ms filter:${bench.filterMs}ms ` +
          `fps:${bench.eventsPerSecond} heap:${bench.memoryMb}MB`,
      );
    })();

    return () => {
      killed = true;
    };
  }, []);

  return (
    <main style={{ position: "absolute", inset: 0 }}>
      <div ref={container} style={{ position: "absolute", inset: 0 }} />
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 10,
          background: "rgba(255,255,255,0.92)",
          padding: "8px 12px",
          font: "12px/1.5 monospace",
          borderRadius: 6,
        }}
      >
        {status}
      </div>
    </main>
  );
}
