import path from "node:path";
import { ts } from "ts-morph";
import type { AnalyzerFile } from "./analyze-files";
import { addEvidence, type GraphParts } from "./framework-graph";

export type ManifestEvidence = {
  file: AnalyzerFile;
  start: number;
  end: number;
};

function frameworkDependency(
  file: AnalyzerFile,
  names: string[],
): ManifestEvidence | null {
  try {
    const parsed: unknown = JSON.parse(file.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const groups = parsed as Record<string, unknown>;
    const hasNext = [groups.dependencies, groups.devDependencies].some(
      (group) =>
        group &&
        typeof group === "object" &&
        !Array.isArray(group) &&
        names.some(
          (name) =>
            Object.hasOwn(group, name) &&
            typeof (group as Record<string, unknown>)[name] === "string",
        ),
    );
    if (!hasNext) return null;
  } catch {
    return null;
  }
  const source = ts.parseJsonText(file.path, file.content);
  const statement = source.statements[0];
  if (
    !statement ||
    !ts.isExpressionStatement(statement) ||
    !ts.isObjectLiteralExpression(statement.expression)
  )
    return null;
  for (const group of statement.expression.properties) {
    if (
      !ts.isPropertyAssignment(group) ||
      !ts.isStringLiteral(group.name) ||
      !["dependencies", "devDependencies"].includes(group.name.text) ||
      !ts.isObjectLiteralExpression(group.initializer)
    )
      continue;
    const next = group.initializer.properties.find(
      (item) =>
        ts.isPropertyAssignment(item) &&
        ts.isStringLiteral(item.name) &&
        names.includes(item.name.text),
    );
    if (next) return { file, start: next.getStart(source), end: next.getEnd() };
  }
  return null;
}

export type ManifestLookup = {
  next(filePath: string): ManifestEvidence | null;
  react(filePath: string): ManifestEvidence | null;
};

/**
 * Finds the nearest package manifest above a file and reports the dependency
 * that proves a framework convention. Each manifest is parsed once per
 * framework instead of once for every file that consults it.
 */
export function createManifestLookup(files: AnalyzerFile[]): ManifestLookup {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const cache = new Map<string, ManifestEvidence | null>();
  function dependency(
    file: AnalyzerFile,
    names: string[],
  ): ManifestEvidence | null {
    const key = `${file.path}\n${names.join()}`;
    if (!cache.has(key)) cache.set(key, frameworkDependency(file, names));
    return cache.get(key)!;
  }
  function find(filePath: string, names: string[]): ManifestEvidence | null {
    let directory = path.posix.dirname(filePath);
    while (directory !== ".") {
      const manifest = byPath.get(`${directory}/package.json`);
      if (manifest) return dependency(manifest, names);
      directory = path.posix.dirname(directory);
    }
    const root = byPath.get("package.json");
    return root ? dependency(root, names) : null;
  }
  return {
    next: (filePath) => find(filePath, ["next"]),
    react: (filePath) => find(filePath, ["react", "next"]),
  };
}

export function addManifestEvidence(
  result: ManifestEvidence,
  graph: GraphParts,
): string {
  const { file, start, end } = result;
  const before = file.content.slice(0, start);
  const snippet = file.content.slice(start, end);
  const startLine = before.split(/\r\n|\r|\n/).length;
  return addEvidence(
    {
      id: `${file.path}:${start}:${end}:framework-manifest`,
      filePath: file.path,
      startLine,
      endLine: startLine + snippet.split(/\r\n|\r|\n/).length - 1,
      snippet,
    },
    graph,
  );
}
