import { isEligiblePath } from "@/core/repository/file-filter";

export type LocalFile = { path: string; size: number; content: string };
export type LocalResult = {
  files: LocalFile[];
  skipped: number;
  truncated: boolean;
};
type Entry =
  | { kind: "file"; name: string; getFile(): Promise<File> }
  | { kind: "directory"; name: string; values(): AsyncIterable<Entry> };
export type Directory = Extract<Entry, { kind: "directory" }>;
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 20;
const MAX_FILES = 25;
const MAX_BYTES = 100_000;
const MAX_TOTAL = 1_000_000;

export async function readLocalFiles(
  entries: AsyncIterable<{ path: string; file: () => Promise<File> }>,
): Promise<LocalResult> {
  const result: LocalResult = { files: [], skipped: 0, truncated: false };
  let total = 0;
  let count = 0;
  for await (const entry of entries) {
    if (++count > MAX_ENTRIES) {
      result.truncated = true;
      break;
    }
    if (!isEligiblePath(entry.path)) {
      result.skipped++;
      continue;
    }
    if (result.files.length >= MAX_FILES) {
      result.skipped++;
      result.truncated = true;
      continue;
    }
    const file = await entry.file();
    if (file.size > MAX_BYTES || total + file.size > MAX_TOTAL) {
      result.skipped++;
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.includes(0)) {
      result.skipped++;
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      result.skipped++;
      continue;
    }
    result.files.push({ path: entry.path, size: bytes.length, content });
    total += bytes.length;
  }
  return result;
}

export async function* directoryFiles(
  directory: Directory,
  prefix = "",
  depth = 0,
  counter = { value: 0 },
): AsyncGenerator<{ path: string; file: () => Promise<File> }> {
  if (depth > MAX_DEPTH)
    throw new Error("The folder is nested too deeply to import safely.");
  for await (const entry of directory.values()) {
    if (++counter.value > MAX_ENTRIES)
      throw new Error("The folder contains too many entries to import safely.");
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      if (isEligiblePath(`${path}/placeholder.ts`))
        yield* directoryFiles(entry, path, depth + 1, counter);
    } else yield { path, file: () => entry.getFile() };
  }
}

export async function* selectedFiles(
  files: FileList,
): AsyncGenerator<{ path: string; file: () => Promise<File> }> {
  for (const file of Array.from(files)) {
    const parts = file.webkitRelativePath.split("/");
    if (parts.length < 2) continue;
    yield { path: parts.slice(1).join("/"), file: async () => file };
  }
}
