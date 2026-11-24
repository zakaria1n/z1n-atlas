import path from "node:path";
import { ts } from "ts-morph";
import type { AnalyzerFile } from "./analyze-files";
import type { GraphParts } from "./framework-graph";

type ManifestEvidence = { file: AnalyzerFile; start: number; end: number };
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
function findManifest(
  filePath: string,
  files: AnalyzerFile[],
  names: string[],
): ManifestEvidence | null {
  let directory = path.posix.dirname(filePath);
  while (directory !== ".") {
    const manifest = files.find(
      (file) => file.path === `${directory}/package.json`,
    );
    if (manifest) return frameworkDependency(manifest, names);
    directory = path.posix.dirname(directory);
  }
  const root = files.find((file) => file.path === "package.json");
  return root ? frameworkDependency(root, names) : null;
}
export function findNextManifest(
  filePath: string,
  files: AnalyzerFile[],
): ManifestEvidence | null {
  return findManifest(filePath, files, ["next"]);
}
export function findReactManifest(
  filePath: string,
  files: AnalyzerFile[],
): ManifestEvidence | null {
  return findManifest(filePath, files, ["react", "next"]);
}
export function addManifestEvidence(
  result: ManifestEvidence,
  graph: GraphParts,
): string {
  const { file, start, end } = result;
  const id = `${file.path}:${start}:${end}:framework-manifest`;
  if (!graph.evidence.some((item) => item.id === id)) {
    const before = file.content.slice(0, start);
    const snippet = file.content.slice(start, end);
    const startLine = before.split(/\r\n|\r|\n/).length,
      endLine = startLine + snippet.split(/\r\n|\r|\n/).length - 1;
    graph.evidence.push({
      id,
      filePath: file.path,
      startLine,
      endLine,
      snippet,
    });
  }
  return id;
}
