import { MAX_SOURCE_FILES, MAX_SOURCE_TOTAL_BYTES } from "./limits";

type Candidate = { path: string; size: number };

const manifest = /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]*)?\.json)$/i;
const script = /\.[cm]?[jt]sx?$/i;
const pythonScript = /\.py$/i;
const auxiliaryDirectory =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|test|tests|e2e|cypress|playwright|spec|specs|mocks|fixtures|generated|migrations)\//i;
const auxiliaryName =
  /\.(?:test|spec|stories|mocks?|generated|gen)\.[cm]?[jt]sx?$/i;
const pythonTestName = /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/i;

/**
 * Ranks how useful a file is for relationship analysis. Project manifests
 * come first because they prove framework conventions and path aliases,
 * then application code — JavaScript, TypeScript and Python alike. Tests,
 * stories, mocks, migrations, generated files and ambient declarations rarely
 * explain how a feature runs, and files that are not scripts contribute a
 * node but no relationships.
 */
export function selectionTier(path: string): number {
  if (manifest.test(path)) return 0;
  if (pythonTestName.test(path)) return 2;
  if (pythonScript.test(path)) return auxiliaryDirectory.test(path) ? 2 : 1;
  if (!script.test(path)) return 3;
  if (/\.d\.[cm]?ts$/i.test(path)) return 2;
  return auxiliaryDirectory.test(path) || auxiliaryName.test(path) ? 2 : 1;
}
const TIERS = 4;

/** Groups files by their first two path segments so that coverage is spread across the project. */
function directoryGroups<T extends Candidate>(files: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const parts = file.path.split("/");
    const key =
      parts.length > 2
        ? parts.slice(0, 2).join("/")
        : parts.length === 2
          ? parts[0]
          : "(root)";
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }
  return groups;
}

/**
 * Chooses the files to analyze when a repository exceeds the analysis
 * budget. Files are taken tier by tier, and within a tier round-robin across
 * directories, so that a large project gets broad coverage of its
 * application code instead of an alphabetical prefix of it.
 */
export function selectRepositoryFiles<T extends Candidate>(
  candidates: T[],
): T[] {
  const sorted = [...candidates].sort((a, b) =>
    a.path.localeCompare(b.path, "en"),
  );
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
  for (
    let tier = 0;
    tier < TIERS && selected.length < MAX_SOURCE_FILES;
    tier++
  ) {
    const groups = directoryGroups(
      sorted.filter((item) => selectionTier(item.path) === tier),
    );
    let index = 0;
    let remaining = groups.size > 0;
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
  }
  return selected.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
