import {
  decodeSourceText,
  isEligiblePath,
  MAX_INDEX_FILES,
  MAX_INSPECT_FILE_BYTES,
  MAX_SOURCE_FILE_BYTES,
  selectRepositoryFiles,
} from "@z1n/contracts";

export type LocalFile = { path: string; size: number; content: string };
export type LocalResult = {
  files: LocalFile[];
  skipped: number;
  truncated: boolean;
  inventory: { path: string; size: number }[];
  indexTruncated: boolean;
  readFile: (path: string, signal?: AbortSignal) => Promise<LocalFile>;
};
type Entry =
  | { kind: "file"; name: string; getFile(): Promise<File> }
  | { kind: "directory"; name: string; values(): AsyncIterable<Entry> };
export type LocalEntry = { path: string; file: () => Promise<File> };
export type Directory = Extract<Entry, { kind: "directory" }>;
type Limits = { maxIndexed: number; maxEntries: number };
const DEFAULT_LIMITS: Limits = {
  maxIndexed: MAX_INDEX_FILES,
  maxEntries: 100_000,
};
const MAX_DEPTH = 20;

export async function readLocalFiles(
  entries: AsyncIterable<LocalEntry>,
  {
    signal,
    limits: overrides,
  }: { signal?: AbortSignal; limits?: Partial<Limits> } = {},
): Promise<LocalResult> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...overrides };
  const stored = new Map<string, File>();
  let excluded = 0;
  let indexTruncated = false;
  let scanned = 0;
  // Stopping early closes the directory iterator, so a folder that exceeds
  // either bound yields a partial index instead of blocking or failing.
  for await (const entry of entries) {
    signal?.throwIfAborted();
    if (++scanned > limits.maxEntries) {
      indexTruncated = true;
      break;
    }
    if (!isEligiblePath(entry.path)) {
      excluded++;
      continue;
    }
    const file = await entry.file();
    if (stored.has(entry.path) || file.size > MAX_INSPECT_FILE_BYTES) {
      excluded++;
      continue;
    }
    if (stored.size >= limits.maxIndexed) {
      indexTruncated = true;
      break;
    }
    stored.set(entry.path, file);
  }
  async function readFile(path: string): Promise<LocalFile> {
    const file = stored.get(path);
    if (!file)
      throw new Error("This file is not part of the imported selection.");
    const text = decodeSourceText(new Uint8Array(await file.arrayBuffer()));
    if (!text) throw new Error("The selected file is not supported text.");
    return { path, ...text };
  }
  const inventory = [...stored].map(([path, file]) => ({
    path,
    size: file.size,
  }));
  const selected = selectRepositoryFiles(
    inventory.filter((item) => item.size <= MAX_SOURCE_FILE_BYTES),
  );
  const files: LocalFile[] = [];
  for (const item of selected) {
    signal?.throwIfAborted();
    try {
      files.push(await readFile(item.path));
    } catch {
      /* Entries that turn out not to be text stay indexed and count as skipped. */
    }
  }
  return {
    files,
    inventory,
    readFile,
    skipped: excluded + inventory.length - files.length,
    truncated: indexTruncated || inventory.length > files.length,
    indexTruncated,
  };
}

export async function* directoryFiles(
  directory: Directory,
  signal?: AbortSignal,
  prefix = "",
  depth = 0,
): AsyncGenerator<LocalEntry> {
  if (depth > MAX_DEPTH)
    throw new Error("The folder is nested too deeply to import safely.");
  for await (const entry of directory.values()) {
    signal?.throwIfAborted();
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      if (isEligiblePath(`${path}/placeholder.ts`))
        yield* directoryFiles(entry, signal, path, depth + 1);
    } else yield { path, file: () => entry.getFile() };
  }
}

export async function* selectedFiles(
  files: FileList,
): AsyncGenerator<LocalEntry> {
  for (const file of Array.from(files)) {
    const parts = file.webkitRelativePath.split("/");
    if (parts.length < 2) continue;
    yield { path: parts.slice(1).join("/"), file: async () => file };
  }
}
