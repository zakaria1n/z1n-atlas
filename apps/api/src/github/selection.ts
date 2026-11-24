import { MAX_SOURCE_FILES, MAX_SOURCE_TOTAL_BYTES } from "@z1n/contracts";

type Candidate = { path: string; size: number };
export function selectRepositoryFiles<T extends Candidate>(
  candidates: T[],
): T[] {
  const groups = new Map<string, T[]>();
  const sorted = [...candidates].sort((a, b) =>
    a.path.localeCompare(b.path, "en"),
  );
  const configs = sorted
    .filter((item) =>
      /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]*)?\.json)$/i.test(item.path),
    )
    .slice(0, 20);
  const configPaths = new Set(configs.map((item) => item.path));
  for (const item of sorted) {
    if (configPaths.has(item.path)) continue;
    const parts = item.path.split("/");
    const key =
      parts.length > 2
        ? parts.slice(0, 2).join("/")
        : parts.length === 2
          ? parts[0]
          : "(root)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  const selected: T[] = [];
  let total = 0;
  function add(item: T) {
    if (
      selected.length < MAX_SOURCE_FILES &&
      total + item.size <= MAX_SOURCE_TOTAL_BYTES
    ) {
      selected.push(item);
      total += item.size;
    }
  }
  configs.forEach(add);
  let index = 0;
  let remaining = true;
  while (remaining && selected.length < MAX_SOURCE_FILES) {
    remaining = false;
    for (const group of groups.values()) {
      const item = group[index];
      if (item) {
        add(item);
        remaining = true;
      }
    }
    index++;
  }
  return selected;
}
