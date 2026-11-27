// Local semantic retrieval evaluation: symbol-boundary chunks, the small
// Snowflake embedding model on CPU, and reciprocal rank fusion against the
// lexical index — measured on the same source-verified ground truth as the
// lexical benchmark. Run: node scripts/benchmark-semantic.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createLexicalIndex } from "../apps/api/dist/evidence/lexical-index.js";
import { isEligiblePath } from "../packages/contracts/dist/repository/file-filter.js";
import { analyzeFiles } from "../packages/analysis-core/dist/index.js";

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

const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";
const CHUNK_CHARS = 1200;
const BATCH = 16;
const RRF_K = 60;
const LIMIT = 10;

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
function rrfFuse(rankedListA, rankedListB, limit) {
  const scores = new Map();
  for (const [list] of [rankedListA, rankedListB].map((list) => [list])) {
    list.forEach((filePath, position) => {
      scores.set(
        filePath,
        (scores.get(filePath) ?? 0) + 1 / (RRF_K + position + 1),
      );
    });
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([filePath]) => filePath);
}
function normalize(vector) {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

const heapMb = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

const { pipeline } = await import("@huggingface/transformers");
const base = heapMb();
const loadStart = performance.now();
const extractor = await pipeline(
  "feature-extraction",
  "Snowflake/snowflake-arctic-embed-xs",
  { dtype: "q8" },
);
const loadMs = Math.round(performance.now() - loadStart);

async function embed(texts) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH);
    const output = await extractor(batch, {
      pooling: "cls",
      normalize: true,
    });
    for (let row = 0; row < batch.length; row++)
      vectors.push(
        normalize([
          ...output.data.slice(
            row * output.dims[1],
            (row + 1) * output.dims[1],
          ),
        ]),
      );
  }
  return vectors;
}

console.log("\nLocal semantic retrieval evaluation (CPU, quantized q8)");
console.log("=".repeat(78));
console.log(`model load: ${loadMs}ms, heap base ${base}MB`);

for (const benchmark of BENCHMARKS) {
  const files = loadFiles(
    path.resolve(import.meta.dirname, benchmark.resolve, benchmark.root),
  );
  const graph = await analyzeFiles(files);
  const linesOf = new Map(
    files.map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  // Symbol-boundary chunks: one chunk per graph symbol with its source text.
  const chunks = [];
  for (const node of graph.nodes) {
    const lines = linesOf.get(node.path);
    const text = node.startLine
      ? lines
          .slice(
            node.startLine - 1,
            Math.min(node.endLine ?? node.startLine, node.startLine + 30),
          )
          .join("\n")
          .slice(0, CHUNK_CHARS)
      : node.path;
    chunks.push({
      path: node.path,
      name: node.name ?? "",
      kind: node.kind ?? "file",
      text: `${node.name ?? ""} in ${node.path}\n${text}`.slice(0, CHUNK_CHARS),
    });
  }
  const indexStarted = performance.now();
  const chunkVectors = await embed(chunks.map((chunk) => chunk.text));
  const indexMs = Math.round(performance.now() - indexStarted);
  const lexical = createLexicalIndex(files, graph);

  let lexR5 = 0,
    lexR10 = 0,
    lexMrr = 0,
    semR5 = 0,
    semR10 = 0,
    semMrr = 0,
    hybR5 = 0,
    hybR10 = 0,
    hybMrr = 0;
  let queryMs = 0;
  for (const [question, expected] of benchmark.queries) {
    const started = performance.now();
    const [queryVector] = await embed([QUERY_PREFIX + question]);
    queryMs += performance.now() - started;
    const scored = chunks
      .map((chunk, position) => ({
        path: chunk.path,
        score: chunkVectors[position].reduce(
          (sum, value, index) => sum + value * queryVector[index],
          0,
        ),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, LIMIT)
      .map((item) => item.path);
    const lexicalRanked = lexical
      .search(question, LIMIT)
      .map((hit) => hit.path);
    const hybrid = rrfFuse(lexicalRanked, scored, LIMIT);
    lexR5 += recall(lexicalRanked, expected, 5);
    lexR10 += recall(lexicalRanked, expected, 10);
    lexMrr += reciprocalRank(lexicalRanked, expected);
    semR5 += recall(scored, expected, 5);
    semR10 += recall(scored, expected, 10);
    semMrr += reciprocalRank(scored, expected);
    hybR5 += recall(hybrid, expected, 5);
    hybR10 += recall(hybrid, expected, 10);
    hybMrr += reciprocalRank(hybrid, expected);
  }
  const count = benchmark.queries.length;
  const afterMb = heapMb();
  console.log(
    `\n${benchmark.name} — ${chunks.length} chunks, index ${indexMs}ms, query ${Math.round(queryMs / count)}ms avg, heap ${base}→${afterMb}MB`,
  );
  console.log("             Recall@5  Recall@10  MRR");
  console.log(
    `  lexical    ${String(Math.round((lexR5 / count) * 100) / 100).padEnd(8)}  ${String(Math.round((lexR10 / count) * 100) / 100).padEnd(9)}  ${Math.round((lexMrr / count) * 100) / 100}`,
  );
  console.log(
    `  semantic   ${String(Math.round((semR5 / count) * 100) / 100).padEnd(8)}  ${String(Math.round((semR10 / count) * 100) / 100).padEnd(9)}  ${Math.round((semMrr / count) * 100) / 100}`,
  );
  console.log(
    `  RRF hybrid ${String(Math.round((hybR5 / count) * 100) / 100).padEnd(8)}  ${String(Math.round((hybR10 / count) * 100) / 100).padEnd(9)}  ${Math.round((hybMrr / count) * 100) / 100}`,
  );
}
