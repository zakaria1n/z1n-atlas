"use client";

/**
 * Sigma.js renderer benchmark — development harness, not a product page.
 *
 * Measures the PRODUCTION renderer path end to end: the workspace's
 * deterministic CodeGraph adapter, the real bundled FA2 web worker with its
 * bounded budget, and the same graphology multigraph the workspace renders.
 * Graph snapshots come from the dev-gated /sigma-bench/data route.
 * Exposes window.__bench metrics for the Playwright benchmark.
 */
import { useEffect, useRef, useState } from "react";

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
  workerTerminated: boolean;
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
      workerTerminated: false,
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
          setStatus("WebGL unavailable — production falls back to React Flow."),
        0,
      );
      return;
    }

    (async () => {
      // Sigma touches browser globals at import time, so the renderer is
      // imported inside the browser-only effect.
      const { default: Sigma, DEFAULT_STYLES } = await import("sigma");
      const { default: forceAtlas2 } =
        await import("graphology-layout-forceatlas2");
      const { codeGraphToGraphology } =
        await import("@/features/graph/renderer/adapter");
      const { fa2Settings } =
        await import("@/features/graph/renderer/fa2-settings");
      const data = await fetch(`/sigma-bench/data/${snapshot}`).then(
        (response) => response.json(),
      );
      const tGraph = performance.now();
      const graph = codeGraphToGraphology(data);
      bench.adapterMs = Math.round(performance.now() - tGraph);
      bench.nodes = graph.order;
      bench.edges = graph.size;

      const tLayout = performance.now();
      forceAtlas2.assign(graph, {
        iterations: graph.order > 2000 ? 10 : 30,
        settings: fa2Settings(graph.order),
      });
      bench.seedLayoutMs = Math.round(performance.now() - tLayout);

      if (!container.current || killed) return;
      const renderer = new Sigma(graph, container.current, {
        settings: {
          renderEdgeLabels: false,
          labelDensity: 0.4,
          labelGridCellSize: 120,
        },
        styles: {
          nodes: { ...DEFAULT_STYLES.nodes, labelColor: "#0f172a" },
        },
      });

      // The production bounded FA2 worker, started exactly as the workspace
      // starts it and terminated at the budget.
      const worker = new Worker(
        new URL("@/features/graph/renderer/fa2.worker.ts", import.meta.url),
      );
      const ids = graph.nodes();
      const indexOf = new Map(ids.map((id, index) => [id, index]));
      const positions = new Float32Array(graph.order * 2);
      const sizes = new Float32Array(graph.order);
      ids.forEach((id, index) => {
        const attributes = graph.getNodeAttributes(id);
        positions[index * 2] = attributes.x;
        positions[index * 2 + 1] = attributes.y;
        sizes[index] = attributes.size;
      });
      const edges = new Uint32Array(graph.size * 2);
      let cursor = 0;
      graph.forEachEdge((edge) => {
        const [source, target] = graph.extremities(edge);
        edges[cursor++] = indexOf.get(source) ?? 0;
        edges[cursor++] = indexOf.get(target) ?? 0;
      });
      let firstPositionsAt: number | null = null;
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data as
          { type: "tick"; positions: Float32Array } | { type: "done" };
        if (data.type === "tick") {
          if (firstPositionsAt === null) {
            firstPositionsAt = performance.now();
            bench.workerFirstTickMs = Math.round(firstPositionsAt - tLayout);
          }
          data.positions.forEach((value, index) => {
            const id = ids[Math.floor(index / 2)];
            if (id)
              graph.setNodeAttribute(id, index % 2 === 0 ? "x" : "y", value);
          });
          renderer.refresh();
        } else {
          worker.terminate();
          bench.workerTerminated = true;
        }
      };
      const tWorkerStart = performance.now();
      worker.postMessage({
        type: "start",
        ids,
        edges,
        positions,
        sizes,
        settings: fa2Settings(graph.order),
        budgetMs: 2500,
        chunkIterations: 8,
      });
      void tWorkerStart;

      // First meaningful render: sigma's own first afterRender event.
      const tRender = performance.now();
      await new Promise<void>((resolve) => {
        renderer.on("afterRender", () => resolve());
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
          graph.setNodeAttribute(id, "x", attributes.x);
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
          `fps:${bench.eventsPerSecond} heap:${bench.memoryMb}MB ` +
          `workerDone:${bench.workerTerminated}`,
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
