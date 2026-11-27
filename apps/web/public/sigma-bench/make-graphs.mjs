import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFiles } from "../../../../packages/analysis-core/dist/index.js";
import { isEligiblePath } from "../../../../packages/contracts/dist/repository/file-filter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../..");
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
    dir: path.resolve(webRoot, "../../../omnisport-reference"),
  },
  { name: "z1n-atlas", dir: path.resolve(webRoot, "../..") },
];

for (const repo of REPOS) {
  const files = loadFiles(repo.dir).slice(0, 2000);
  const graph = await analyzeFiles(files);
  writeFileSync(
    path.join(here, `graphs/${repo.name}.json`),
    JSON.stringify(graph),
  );
  console.log(
    repo.name,
    graph.nodes.length,
    "nodes",
    graph.edges.length,
    "edges",
  );
}
console.log("DONE");
