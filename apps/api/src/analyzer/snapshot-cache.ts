import { createHash } from "node:crypto";
import type { CodeGraph } from "@z1n/contracts";
import {
  createLexicalIndex,
  type LexicalIndex,
} from "../evidence/lexical-index";
import {
  buildRepositoryContext,
  type RepositoryContext,
} from "../context/builder";
import {
  createSemanticIndex,
  type SemanticIndex,
} from "../evidence/semantic-index";
import { createGraphAdapter, type GraphAdapter } from "../graph/adapter";
import {
  buildIntelligence,
  type GraphIntelligence,
} from "../graph/intelligence";

type Source = { path: string; content: string };

/**
 * One immutable analyzed repository snapshot and the repository-scoped
 * indexes derived from it. The identity is the content digest of the source
 * selection: identical files always share indexes, any changed file gets a
 * fresh snapshot, so an index can never outlive its source.
 */
export type RepositorySnapshot = {
  identity: string;
  files: Source[];
  graph: CodeGraph;
  lexical: LexicalIndex;
  context: RepositoryContext;
  /** Repository-scoped graphology adapter for graph algorithms. */
  adapter: GraphAdapter;
  /** Entry points, static processes and structural groupings. */
  intelligence: GraphIntelligence;
  /**
   * Builds the semantic index on first use and caches it for the
   * snapshot's lifetime, so unchanged source is never re-embedded. A
   * failed build resolves to an unavailable index (lexical-only).
   */
  ensureSemantic: (signal?: AbortSignal) => Promise<SemanticIndex>;
  /**
   * The honest semantic state of this snapshot: "building" while the
   * first eligible request is still embedding, then "ready" or
   * "unavailable". Chat reports it instead of claiming hybrid retrieval
   * that did not happen.
   */
  semanticState: () => "idle" | "building" | "ready" | "unavailable";
};

const digest = (files: Source[]): string => {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(String(Buffer.byteLength(file.path)));
    hash.update(":");
    hash.update(file.path);
    hash.update(String(Buffer.byteLength(file.content)));
    hash.update(":");
    hash.update(file.content);
  }
  return hash.digest("hex");
};

export function createSnapshotCache({ maxEntries = 3, ttlMs = 600_000 } = {}) {
  const entries = new Map<
    string,
    { snapshot: RepositorySnapshot; timer: ReturnType<typeof setTimeout> }
  >();
  function remove(identity: string) {
    const entry = entries.get(identity);
    if (entry) clearTimeout(entry.timer);
    entries.delete(identity);
  }
  return {
    /**
     * Returns the snapshot for this exact source selection, building its
     * indexes on first use. Eviction is oldest-first with a TTL, and the
     * stored snapshots themselves stay bounded by the analysis limits.
     */
    obtain(files: Source[], graph: CodeGraph): RepositorySnapshot {
      const identity = digest(files);
      const existing = entries.get(identity);
      if (existing) return existing.snapshot;
      while (entries.size >= maxEntries) remove(entries.keys().next().value!);
      let semanticPromise: Promise<SemanticIndex> | undefined;
      let semanticStateValue: "idle" | "building" | "ready" | "unavailable" =
        "idle";
      const adapter = createGraphAdapter(graph);
      const intelligence = buildIntelligence(graph, adapter);
      const snapshot: RepositorySnapshot = {
        identity: identity.slice(0, 32),
        files,
        graph,
        lexical: createLexicalIndex(files, graph),
        context: buildRepositoryContext(
          identity.slice(0, 32),
          files,
          graph,
          intelligence,
        ),
        adapter,
        intelligence,
        ensureSemantic: (signal?: AbortSignal) => {
          // Concurrent callers share one build. A cancelled build clears
          // the cached attempt so the next request rebuilds from scratch;
          // a completed build (ready or unavailable) stays cached.
          if (semanticPromise) return semanticPromise;
          semanticStateValue = "building";
          const attempt = createSemanticIndex(files, graph, { signal }).then(
            (index) => {
              semanticStateValue = index.available ? "ready" : "unavailable";
              return index;
            },
          );
          semanticPromise = attempt.catch((error): SemanticIndex => {
            if (signal?.aborted) {
              semanticPromise = undefined;
              semanticStateValue = "idle";
            } else {
              semanticStateValue = "unavailable";
            }
            return { available: false, search: async () => [] };
          });
          return semanticPromise;
        },
        semanticState: () => semanticStateValue,
      };
      const timer = setTimeout(() => remove(identity), ttlMs);
      timer.unref();
      entries.set(identity, { snapshot, timer });
      return snapshot;
    },
    get size(): number {
      return entries.size;
    },
    clear() {
      for (const identity of [...entries.keys()]) remove(identity);
    },
  };
}

export type SnapshotCache = ReturnType<typeof createSnapshotCache>;
