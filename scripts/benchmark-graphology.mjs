// Graphology evaluation: directed multigraph adapter versus the current
// edge-scan operations, measured on the largest real snapshot (Dub-scale).
// Correctness check: parallel edges between the same nodes stay distinct.
//   node --max-old-space-size=4096 scripts/benchmark-graphology.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyzeFiles } from "../packages/analysis-core/dist/index.js";
import { isEligiblePath } from "../packages/contracts/dist/repository/file-filter.js";
import Graphology from "graphology";
import * as shortestPath from "graphology-shortest-path";
import { connectedComponents as connectedComponentsFn } from "graphology-components";

const SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "test-results",
]);

function loadFiles(dir) {
  const files = [];
  const walk = (current, prefix = "") => {
    for (const entry of readdirSync(current)) {
      const absolute = path.join(current, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (SKIP.has(entry)) continue;
      if (statSync(absolute).isDirectory()) walk(absolute, relative);
      else if (isEligiblePath(relative)) {
        const content = readFileSync(absolute, "utf8");
        if (Buffer.byteLength(content) <= 256 * 1024)
          files.push({ path: relative, content });
      }
    }
  };
  walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function buildGraphology(graph) {
  const multi = new Graphology.MultiDirectedGraph();
  for (const node of graph.nodes)
    multi.addNode(node.id, { path: node.path, kind: node.kind ?? "file" });
  for (const edge of graph.edges)
    multi.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
      kind: edge.kind,
      confidence: edge.confidence,
    });
  return multi;
}

const samples = [];
const REPOS = [
  { name: "omnisport", dir: "../omnisport-reference", resolve: ".." },
  { name: "z1n-atlas", dir: "..", resolve: "." },
];

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

for (const repo of REPOS) {
  const files = loadFiles(
    path.resolve(import.meta.dirname, repo.resolve, repo.dir),
  );
  const graph = await analyzeFiles(files);
  const t0 = performance.now();
  const multi = buildGraphology(graph);
  const buildMs = Math.round(performance.now() - t0);
  const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  // Sample nodes with at least one edge for neighborhood benchmarks.
  const nodeIds = graph.nodes
    .filter((node) => node.kind && node.kind !== "file")
    .slice(0, 400)
    .map((node) => node.id);
  // (a) neighborhood extraction: current = full edge scan, graphology = index.
  const scanTimes = [],
    gxTimes = [];
  for (const id of nodeIds.slice(0, 120)) {
    let t = performance.now();
    graph.edges.filter((edge) => edge.source === id || edge.target === id);
    scanTimes.push(performance.now() - t);
    t = performance.now();
    multi.edges(id);
    gxTimes.push(performance.now() - t);
  }
  // (b) directed shortest paths between connected pairs (graphology only —
  // the current code has no reusable shortest-path operation).
  const pathTimes = [];
  let pathFound = 0;
  const pairs = [];
  for (const edge of graph.edges.slice(0, 400))
    pairs.push([edge.source, edge.target]);
  for (const [from, to] of pairs.slice(0, 100)) {
    const t = performance.now();
    try {
      const walked = shortestPath.bidirectional(multi, from, to);
      if (walked) pathFound += 1;
    } catch {}
    pathTimes.push(performance.now() - t);
  }
  // (c) connected components (graphology-only capability).
  const t1 = performance.now();
  const components = connectedComponentsFn(multi);
  const componentsMs = Math.round(performance.now() - t1);
  // (d) correctness: parallel edges between the same pair stay distinct.
  let parallelPreserved = null;
  const pairCounts = new Map();
  for (const edge of graph.edges) {
    const key = `${edge.source}\u0000${edge.target}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const duplicated = [...pairCounts.entries()].find(([, count]) => count > 1);
  if (duplicated) {
    const [source, target] = duplicated[0].split("\u0000");
    parallelPreserved = multi.edges(source, target).length === duplicated[1];
  }
  samples.push({
    name: repo.name,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    buildMs,
    heapMb,
    scanMs: Math.round(median(scanTimes) * 1000) / 1000,
    gxMs: Math.round(median(gxTimes) * 1000) / 1000,
    pathMedianMs: Math.round(median(pathTimes) * 1000) / 1000,
    pathFound,
    pathTotal: Math.min(100, pairs.length),
    componentsMs,
    componentCount: components.length,
    parallelPreserved,
  });
}

console.log("\nGraphology adapter evaluation (MultiDirectedGraph)");
console.log("=".repeat(78));
for (const sample of samples) {
  console.log(
    `\n${sample.name} — ${sample.nodes} nodes, ${sample.edges} edges, adapter build ${sample.buildMs}ms, heap ${sample.heapMb}MB`,
  );
  console.log(
    `  neighborhood (median): edge-scan ${sample.scanMs}ms vs graphology ${sample.gxMs}ms`,
  );
  console.log(
    `  directed shortest path: ${sample.pathMedianMs}ms median, ${sample.pathFound}/${sample.pathTotal} pairs connected`,
  );
  console.log(
    `  connected components: ${sample.componentCount} in ${sample.componentsMs}ms`,
  );
  console.log(
    `  parallel edges preserved: ${sample.parallelPreserved ?? "no duplicate pair in this graph"}`,
  );
}
