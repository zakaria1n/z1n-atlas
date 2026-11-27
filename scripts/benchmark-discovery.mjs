// Discovery quality comparison: the current discovery ranking versus the
// same ranking boosted by structural entry-point scores, on the
// source-verified ground truth. Gate: boost must preserve or improve
// Recall before it is wired into discovery.
//   node --max-old-space-size=3072 scripts/benchmark-discovery.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyzeFiles } from "../packages/analysis-core/dist/index.js";
import { isEligiblePath } from "../packages/contracts/dist/repository/file-filter.js";
import { createGraphAdapter } from "../apps/api/dist/graph/adapter.js";
import { entryPointScores } from "../apps/api/dist/graph/intelligence.js";

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

// Mirrors journey/discovery.ts scoring (term overlap on name/path/signals)
// so the comparison isolates exactly the entry-point boost under decision.
function discoveryRanking(graph, question, boost) {
  const terms = (
    question.toLowerCase().match(/[a-z_$][a-z0-9_$.-]{2,}/g) ?? []
  ).filter(
    (term) =>
      ![
        "the",
        "and",
        "how",
        "does",
        "what",
        "where",
        "this",
        "that",
        "with",
        "from",
      ].includes(term),
  );
  return graph.nodes
    .filter((node) => node.kind && node.kind !== "file")
    .map((node) => {
      const haystack = `${node.name ?? ""} ${node.path}`.toLowerCase();
      let score = terms.reduce(
        (sum, term) => sum + (haystack.split(term).length - 1),
        0,
      );
      if (score > 0) {
        const entry = boost.get(node.id);
        if (entry) score *= 1 + Math.min(1, entry.score / 8);
      }
      return { path: node.path, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
    .map((item) => item.path);
}

const BENCHMARKS = [
  {
    name: "omnisport",
    root: "../omnisport-reference",
    resolve: "..",
    queries: [
      ["book a sports facility", ["bookings.py", "facilities.py"]],
      ["user login and authentication", ["auth.py", "security.py"]],
      ["check the availability of a time slot", ["availability.py"]],
      [
        "cancellation of a confirmed booking",
        ["booking_state.py", "bookings.py"],
      ],
      ["send a notification to the user", ["notifications.py"]],
      ["price and pricing of a facility", ["facilities.py", "availability.py"]],
      ["account registration of a new user", ["accounts.py", "auth.py"]],
      ["seed the initial catalog data", ["seed.py"]],
      ["facility catalog and complex listing", ["catalog.py", "facilities.py"]],
      ["database models and schema", ["models.py"]],
    ],
  },
  {
    name: "z1n-atlas",
    root: "..",
    resolve: ".",
    queries: [
      ["validate a journey against the graph", ["contracts/src/journey.ts"]],
      ["analyze selected files into a code graph", ["analyze-files.ts"]],
      ["detect the Prisma client construction", ["prisma-access.ts"]],
      [
        "resolve module imports with the nearest tsconfig",
        ["module-resolution.ts"],
      ],
      ["chat answer evidence retrieval", ["evidence/answer.ts"]],
      ["validate graph evidence snippets", ["validate-graph.ts"]],
      ["journey tool definitions for the model", ["journey/tools.ts"]],
      ["rank discovery candidates for a feature", ["journey/discovery.ts"]],
      [
        "state graph orchestration of the journey loop",
        ["orchestration/journey-graph.ts"],
      ],
      ["server managed ai credential configuration", ["config.ts"]],
    ],
  },
];

function endsWithAny(filePath, expected) {
  return expected.some(
    (suffix) => filePath.endsWith(suffix) || filePath.includes(suffix),
  );
}
function recall(rankedList, expected, k) {
  const hits = rankedList
    .slice(0, k)
    .filter((p) => endsWithAny(p, expected)).length;
  return Math.min(1, hits / expected.length);
}

console.log("\nDiscovery ranking: baseline vs entry-point boost (structural)");
console.log("=".repeat(74));
for (const benchmark of BENCHMARKS) {
  const files = loadFiles(
    path.resolve(import.meta.dirname, benchmark.resolve, benchmark.root),
  );
  const graph = await analyzeFiles(files);
  const adapter = createGraphAdapter(graph);
  const boost = new Map(
    entryPointScores(graph, adapter).map((entry) => [entry.nodeId, entry]),
  );
  let baseR5 = 0,
    baseR10 = 0,
    boostR5 = 0,
    boostR10 = 0;
  for (const [question, expected] of benchmark.queries) {
    const base = discoveryRanking(graph, question, new Map());
    const boosted = discoveryRanking(graph, question, boost);
    baseR5 += recall(base, expected, 5);
    baseR10 += recall(base, expected, 10);
    boostR5 += recall(boosted, expected, 5);
    boostR10 += recall(boosted, expected, 10);
  }
  const count = benchmark.queries.length;
  const round = (value) => Math.round((value / count) * 100) / 100;
  console.log(`\n${benchmark.name}:`);
  console.log(
    `  baseline:        Recall@5 ${round(baseR5)}  Recall@10 ${round(baseR10)}`,
  );
  console.log(
    `  entry-point mix: Recall@5 ${round(boostR5)}  Recall@10 ${round(boostR10)}`,
  );
}
