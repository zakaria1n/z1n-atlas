import { createHash, randomUUID } from "node:crypto";
import type { CodeGraph } from "@z1n/contracts";
import { MAX_GRAPH_BYTES } from "./limits";

type Source = { path: string; content: string };
type Entry = {
  digest: string;
  graph: CodeGraph;
  timer: ReturnType<typeof setTimeout>;
};
function digest(files: Source[]) {
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
}
export function createAnalysisCache({
  maxEntries = 2,
  maxBytes = MAX_GRAPH_BYTES,
  ttlMs = 300_000,
} = {}) {
  const entries = new Map<string, Entry>();
  function remove(id: string) {
    const entry = entries.get(id);
    if (entry) clearTimeout(entry.timer);
    entries.delete(id);
  }
  return {
    put(files: Source[], graph: CodeGraph): string | undefined {
      if (Buffer.byteLength(JSON.stringify(graph)) > maxBytes || maxEntries < 1)
        return undefined;
      while (entries.size >= maxEntries) remove(entries.keys().next().value!);
      const id = randomUUID();
      const timer = setTimeout(() => remove(id), ttlMs);
      timer.unref();
      entries.set(id, { digest: digest(files), graph, timer });
      return id;
    },
    get(id: string | undefined, files: Source[]): CodeGraph | undefined {
      if (!id) return undefined;
      const entry = entries.get(id);
      return entry && entry.digest === digest(files) ? entry.graph : undefined;
    },
    clear() {
      for (const id of entries.keys()) remove(id);
    },
  };
}
