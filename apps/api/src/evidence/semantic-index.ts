import type { CodeGraph } from "@z1n/contracts";

type Source = { path: string; content: string };

export type SemanticHit = {
  nodeId: string;
  path: string;
  startLine: number;
  endLine: number;
  name: string | null;
  score: number;
};

export type SemanticIndex = {
  readonly available: boolean;
  search(question: string, limit?: number): Promise<SemanticHit[]>;
};

const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";
const CHUNK_CHARS = 1200;
const BATCH = 16;
const MODEL = "Snowflake/snowflake-arctic-embed-xs";

type Embedder = (
  texts: string[],
  options: Record<string, unknown>,
) => Promise<{ data: Float32Array; dims: number[] }>;

// The model loads once per process; a failed load (no network, no runtime)
// stays failed so every later request degrades to lexical immediately.
let embedderPromise: Promise<Embedder | null> | undefined;

async function getEmbedder(): Promise<Embedder | null> {
  if (!embedderPromise)
    embedderPromise = (async () => {
      try {
        const { pipeline } = await import("@huggingface/transformers");
        const extractor = await pipeline("feature-extraction", MODEL, {
          dtype: "q8",
        });
        return ((texts: string[], options: Record<string, unknown>) =>
          extractor(texts, options as never)) as Embedder;
      } catch {
        return null;
      }
    })();
  return embedderPromise;
}

const normalize = (vector: number[]): number[] => {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
};

async function embedTexts(
  embed: Embedder,
  texts: string[],
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const output = await embed(texts.slice(start, start + BATCH), {
      pooling: "cls",
      normalize: true,
    });
    const width = output.dims[1];
    const rows = output.dims[0];
    const flat = output.data as Float32Array;
    for (let row = 0; row < rows; row++)
      vectors.push(normalize([...flat.slice(row * width, (row + 1) * width)]));
  }
  return vectors;
}

/**
 * A semantic index over the analyzed snapshot's symbols: one chunk per
 * graph symbol, embedded locally on CPU with a small quantized model.
 * Each chunk keeps its exact node identity, path and line span, so a
 * result never collapses distinct functions of one file. Unavailable is
 * an honest state: the caller then runs lexical-only retrieval.
 */
export async function createSemanticIndex(
  files: Source[],
  graph: CodeGraph,
): Promise<SemanticIndex> {
  const embed = await getEmbedder();
  if (!embed) return { available: false, search: async () => [] };
  const linesOf = new Map(
    files.map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  const chunks = graph.nodes.map((node) => {
    const lines = linesOf.get(node.path);
    const text = node.startLine
      ? (lines ?? [])
          .slice(
            node.startLine - 1,
            Math.min(node.endLine ?? node.startLine, node.startLine + 30),
          )
          .join("\n")
          .slice(0, CHUNK_CHARS)
      : node.path;
    return {
      node,
      text: `${node.name ?? ""} in ${node.path}\n${text}`.slice(0, CHUNK_CHARS),
    };
  });
  let chunkVectors: number[][] | undefined;
  try {
    chunkVectors = await embedTexts(
      embed,
      chunks.map((chunk) => chunk.text),
    );
  } catch {
    return { available: false, search: async () => [] };
  }
  const queryVectors = new Map<string, number[]>();
  return {
    available: true,
    async search(question: string, limit = 10): Promise<SemanticHit[]> {
      let queryVector = queryVectors.get(question);
      if (!queryVector) {
        try {
          const [vector] = await embedTexts(embed, [QUERY_PREFIX + question]);
          queryVector = vector;
          queryVectors.set(question, vector);
        } catch {
          return [];
        }
      }
      return chunks
        .map((chunk, position) => ({
          hit: {
            nodeId: chunk.node.id,
            path: chunk.node.path,
            startLine: chunk.node.startLine ?? 1,
            endLine: chunk.node.endLine ?? chunk.node.startLine ?? 1,
            name: chunk.node.name ?? null,
            score: chunkVectors![position].reduce(
              (sum, value, index) => sum + value * queryVector![index],
              0,
            ),
          },
        }))
        .sort((left, right) => right.hit.score - left.hit.score)
        .slice(0, limit)
        .map((item) => item.hit);
    },
  };
}
