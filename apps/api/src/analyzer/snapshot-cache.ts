import { createHash } from "node:crypto";
import type { CodeGraph } from "@z1n/contracts";
import {
  createLexicalIndex,
  type LexicalIndex,
} from "../evidence/lexical-index";

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
      const snapshot: RepositorySnapshot = {
        identity: identity.slice(0, 32),
        files,
        graph,
        lexical: createLexicalIndex(files, graph),
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
