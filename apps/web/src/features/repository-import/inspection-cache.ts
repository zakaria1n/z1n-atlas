import type { SourceFile } from "./repository-session";

type ReadFile = (path: string, signal?: AbortSignal) => Promise<SourceFile>;

/**
 * Remembers recently inspected files so that reopening one does not request
 * it from the rate-limited backend again. Least recently used entries are
 * evicted first, and the total retained size stays bounded.
 */
export function cacheInspections(
  readFile: ReadFile,
  { maxEntries = 100, maxBytes = 8_000_000 } = {},
): ReadFile {
  const entries = new Map<string, SourceFile>();
  let bytes = 0;
  return async (path, signal) => {
    const cached = entries.get(path);
    if (cached) {
      entries.delete(path);
      entries.set(path, cached);
      return cached;
    }
    const file = await readFile(path, signal);
    if (!entries.has(path) && file.size <= maxBytes) {
      entries.set(path, file);
      bytes += file.size;
      for (const [key, value] of entries) {
        if (entries.size <= maxEntries && bytes <= maxBytes) break;
        entries.delete(key);
        bytes -= value.size;
      }
    }
    return file;
  };
}
