// Complete index lifecycle benchmark: analysis, snapshot-scoped index
// build, first (cold) query, repeated queries, end-to-end retrieval and
// memory consumption — measured on real repository snapshots.
//   node scripts/benchmark-index-lifecycle.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { analyzeFiles } from "../packages/analysis-core/dist/index.js";
import { isEligiblePath } from "../packages/contracts/dist/repository/file-filter.js";
import { createLexicalIndex } from "../apps/api/dist/evidence/lexical-index.js";
import { collectEvidence } from "../apps/api/dist/evidence/answer.js";

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

const REPOS = [
  {
    name: "omnisport",
    dir: "../omnisport-reference",
    resolve: "..",
    query: "How does a user book a facility?",
  },
  {
    name: "z1n-atlas",
    dir: "..",
    resolve: ".",
    query: "How is a booking committed to the database?",
  },
];

const heapMb = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

console.log("\nRepository-scoped index lifecycle benchmark");
console.log("=".repeat(78));
for (const repo of REPOS) {
  const base = heapMb();
  const t0 = performance.now();
  const files = loadFiles(
    path.resolve(import.meta.dirname, repo.resolve, repo.dir),
  );
  const loadMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const graph = await analyzeFiles(files);
  const analysisMs = Math.round(performance.now() - t1);
  const t2 = performance.now();
  const index = createLexicalIndex(files, graph);
  const indexBuildMs = Math.round(performance.now() - t2);
  const t3 = performance.now();
  index.search(repo.query, 6);
  const firstQueryMs = Math.round((performance.now() - t3) * 10) / 10;
  const t4 = performance.now();
  const repeats = 20;
  for (let i = 0; i < repeats; i++) index.search(repo.query, 6);
  const repeatQueryMs =
    Math.round(((performance.now() - t4) / repeats) * 100) / 100;
  const t5 = performance.now();
  collectEvidence(repo.query, files, graph, [], index);
  const endToEndMs = Math.round(performance.now() - t5);
  // Identity cost: the digest every request computes to find its snapshot.
  const t6 = performance.now();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(String(Buffer.byteLength(file.path)));
    hash.update(":");
    hash.update(file.path);
    hash.update(String(Buffer.byteLength(file.content)));
    hash.update(":");
    hash.update(file.content);
  }
  hash.digest("hex");
  const digestMs = Math.round((performance.now() - t6) * 10) / 10;
  const afterMb = heapMb();
  console.log(
    `\n${repo.name} — ${files.length} files, ${graph.nodes.length} nodes, heap ${base}→${afterMb}MB`,
  );
  console.log(`  source load:            ${loadMs}ms`);
  console.log(`  analysis:               ${analysisMs}ms`);
  console.log(`  index build:            ${indexBuildMs}ms`);
  console.log(`  first query (cold):     ${firstQueryMs}ms`);
  console.log(`  repeated query (warm):  ${repeatQueryMs}ms`);
  console.log(`  end-to-end retrieval:   ${endToEndMs}ms`);
  console.log(`  snapshot digest/req:    ${digestMs}ms`);
}
console.log("\nEnd-to-end = one full chat evidence collection on the cached");
console.log("index (term search + relationship scoring + lexical anchors +");
console.log("discovery). Digest cost is paid per request for identity.");
