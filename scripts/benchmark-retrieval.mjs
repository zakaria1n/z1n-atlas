// Retrieval benchmark: the current term-count ranking versus an indexed
// MiniSearch implementation, measured on real repository snapshots with
// source-verified expected files. Run from the repository root:
//   node scripts/benchmark-retrieval.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import MiniSearch from "minisearch";
import { analyzeFiles } from "../packages/analysis-core/dist/index.js";

const STOP = new Set([
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
  "when",
  "which",
  "into",
  "onto",
  "per",
  "for",
  "was",
  "is",
  "are",
  "of",
  "in",
  "on",
  "to",
  "it",
  "its",
  "user",
]);

function loadFiles(dir) {
  const files = [];
  const SKIP = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "coverage",
    "test-results",
  ]);
  const walk = (current, prefix = "") => {
    for (const entry of readdirSync(current)) {
      const absolute = path.join(current, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (SKIP.has(entry)) continue;
      if (statSync(absolute).isDirectory()) walk(absolute, relative);
      else {
        const content = readFileSync(absolute, "utf8");
        if (Buffer.byteLength(content) <= 256 * 1024)
          files.push({ path: relative, content });
      }
    }
  };
  walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function termsOf(question) {
  return [
    ...new Set(question.toLowerCase().match(/[a-z_$][a-z0-9_$.-]{2,}/g) ?? []),
  ]
    .filter((term) => !STOP.has(term))
    .slice(0, 8);
}

/** The ranking in production today: term counts over path, name and source. */
function currentRanking(question, files, graph, limit) {
  const terms = termsOf(question);
  const linesOf = new Map(
    files.map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  const docs = graph.nodes.map((node) => {
    const lines = linesOf.get(node.path);
    const excerpt = node.startLine
      ? lines
          .slice(
            node.startLine - 1,
            Math.min(node.endLine ?? node.startLine, node.startLine + 12),
          )
          .join(" ")
          .slice(0, 600)
      : node.path;
    return {
      node,
      text: `${node.path} ${node.name ?? ""} ${excerpt}`.toLowerCase(),
    };
  });
  const scored = docs
    .map(({ node, text }) => ({
      node,
      score: terms.reduce((sum, term) => sum + text.split(term).length - 1, 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  return scored.map(({ node }) => node.path);
}

const tokenize = (text) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.$-]/g, " ")
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g) ?? [];

/** An indexed MiniSearch ranker over the same graph symbols. */
function miniSearchRanking(index, question, limit) {
  const terms = tokenize(question.toLowerCase()).slice(0, 8);
  const stems = terms.map((term) =>
    term.replace(/(?:ations?|ings?|ed|es|s)$/, ""),
  );
  const query = [...new Set([...terms, ...stems])].slice(0, 16).join(" ");
  return index
    .search(query, { prefix: true, fuzzy: 0.1 })
    .slice(0, limit)
    .map((hit) => hit.path);
}

function buildIndex(files, graph) {
  const linesOf = new Map(
    files.map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  const documents = graph.nodes.map((node, position) => {
    const lines = linesOf.get(node.path);
    const excerpt = node.startLine
      ? lines
          .slice(
            node.startLine - 1,
            Math.min(node.endLine ?? node.startLine, node.startLine + 12),
          )
          .join(" ")
          .slice(0, 600)
      : node.path;
    return {
      id: `${node.id}#${position}`,
      path: node.path,
      name: node.name ?? "",
      kind: node.kind ?? "file",
      excerpt,
    };
  });
  const index = new MiniSearch({
    fields: ["path", "name", "excerpt"],
    storeFields: ["path"],
    tokenize,
    processTerm: (term) => (term.length >= 2 ? term : null),
  });
  index.addAll(documents);
  return index;
}

const BENCHMARKS = [
  {
    name: "omnisport (Python/Next.js)",
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
    name: "z1n-atlas (TypeScript, self-analysis)",
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
    .filter((filePath) => endsWithAny(filePath, expected)).length;
  return Math.min(1, hits / expected.length);
}

function reciprocalRank(rankedList, expected) {
  const position = rankedList.findIndex((filePath) =>
    endsWithAny(filePath, expected),
  );
  return position < 0 ? 0 : 1 / (position + 1);
}

const LIMIT = 10;
const results = [];
for (const benchmark of BENCHMARKS) {
  const files = loadFiles(
    path.resolve(
      import.meta.dirname,
      benchmark.resolve ?? benchmark.root,
      benchmark.root,
    ),
  );
  const started = performance.now();
  const graph = await analyzeFiles(files);
  const analysisMs = Math.round(performance.now() - started);
  const indexStarted = performance.now();
  const index = buildIndex(files, graph);
  const indexMs = Math.round(performance.now() - indexStarted);

  let currentR5 = 0,
    currentR10 = 0,
    currentMrr = 0,
    currentLatency = 0;
  let miniR5 = 0,
    miniR10 = 0,
    miniMrr = 0,
    miniLatency = 0;
  for (const [question, expected] of benchmark.queries) {
    let startedAt = performance.now();
    const current = currentRanking(question, files, graph, LIMIT);
    currentLatency += performance.now() - startedAt;
    startedAt = performance.now();
    const mini = miniSearchRanking(index, question, LIMIT);
    miniLatency += performance.now() - startedAt;
    currentR5 += recall(current, expected, 5);
    currentR10 += recall(current, expected, 10);
    currentMrr += reciprocalRank(current, expected);
    miniR5 += recall(mini, expected, 5);
    miniR10 += recall(mini, expected, 10);
    miniMrr += reciprocalRank(mini, expected);
  }
  const count = benchmark.queries.length;
  results.push({
    name: benchmark.name,
    files: files.length,
    nodes: graph.nodes.length,
    analysisMs,
    indexMs,
    current: {
      r5: (currentR5 / count).toFixed(2),
      r10: (currentR10 / count).toFixed(2),
      mrr: (currentMrr / count).toFixed(2),
      ms: (currentLatency / count).toFixed(1),
    },
    mini: {
      r5: (miniR5 / count).toFixed(2),
      r10: (miniR10 / count).toFixed(2),
      mrr: (miniMrr / count).toFixed(2),
      ms: (miniLatency / count).toFixed(1),
    },
  });
}

console.log("\nRetrieval benchmark — current term-count vs MiniSearch indexed");
console.log("=".repeat(86));
for (const result of results) {
  console.log(
    `\n${result.name}  (${result.files} files, ${result.nodes} nodes, analysis ${result.analysisMs}ms, index ${result.indexMs}ms)`,
  );
  console.log("              Recall@5  Recall@10  MRR     latency/query");
  console.log(
    `  current     ${result.current.r5.padEnd(8)}  ${result.current.r10.padEnd(9)}  ${result.current.mrr.padEnd(6)}  ${result.current.ms}ms`,
  );
  console.log(
    `  minisearch  ${result.mini.r5.padEnd(8)}  ${result.mini.r10.padEnd(9)}  ${result.mini.mrr.padEnd(6)}  ${result.mini.ms}ms`,
  );
}
console.log("\nExpected results are source-verified file sets; recall is the");
console.log("fraction of expected files present in the top-k, capped at 1.");
