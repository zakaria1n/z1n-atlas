import {
  Project,
  SyntaxKind,
  type SourceFile as MorphSourceFile,
} from "ts-morph";
import { addNextEntrypoints } from "./next-entrypoints";
import { addPrismaAccess } from "./prisma-access";
import { addHttpRelationships } from "./http-relationships";
import { addSymbolsAndCalls } from "./symbols-and-calls";
import { compilerOptions } from "./compiler-options";
import { addReactEvents } from "./react-events";
import type { CodeGraph, GraphEvidence, GraphEdge } from "@z1n/contracts";

export type AnalyzerFile = { path: string; content: string };
const script = /\.[cm]?[jt]sx?$/i;
function exportedNames(source: MorphSourceFile): string[] {
  const declarations = [
    ...source.getFunctions(),
    ...source.getClasses(),
    ...source.getInterfaces(),
    ...source.getTypeAliases(),
    ...source.getEnums(),
  ];
  const names = declarations
    .filter((item) => item.isExported())
    .map((item) => item.getName())
    .filter((name): name is string => Boolean(name));
  for (const statement of source.getVariableStatements())
    if (statement.isExported())
      for (const declaration of statement.getDeclarations()) {
        const name = declaration.getName();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
      }
  return [...new Set(names)].sort();
}
export type AnalysisStage =
  "parsing" | "imports" | "symbols" | "frameworks" | "validating";
export function analyzeFiles(
  files: AnalyzerFile[],
  progress?: (stage: AnalysisStage) => void,
): CodeGraph {
  progress?.("parsing");
  const scripts = files.filter((file) => script.test(file.path));
  const { options, configNotice } = compilerOptions(files);
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: options,
  });
  for (const file of scripts)
    project.createSourceFile(`/workspace/${file.path}`, file.content);
  const paths = new Set(scripts.map((file) => file.path));
  const edges: GraphEdge[] = [];
  const evidence: GraphEvidence[] = [];
  let unresolved = 0;
  const nodes = scripts.map((file) => ({
    id: file.path,
    path: file.path,
    exports: exportedNames(
      project.getSourceFileOrThrow(`/workspace/${file.path}`),
    ),
  }));
  progress?.("imports");
  for (const file of scripts) {
    const source = project.getSourceFileOrThrow(`/workspace/${file.path}`);
    const relations = [
      ...source.getImportDeclarations().map((node) => ({
        node,
        resolved: node.getModuleSpecifierSourceFile(),
        kind: "imports" as const,
      })),
      ...source.getExportDeclarations().flatMap((node) => {
        return node.getModuleSpecifierValue()
          ? [
              {
                node,
                resolved: node.getModuleSpecifierSourceFile(),
                kind: "re-exports" as const,
              },
            ]
          : [];
      }),
    ];
    for (const relation of relations) {
      const target = relation.resolved
        ?.getFilePath()
        .replace(/^\/workspace\//, "");
      if (target && !paths.has(target)) {
        unresolved++;
        continue;
      }
      if (!target) {
        unresolved++;
        continue;
      }
      const startLine = relation.node.getStartLineNumber();
      const endLine = relation.node.getEndLineNumber();
      const id = `${file.path}:${relation.node.getStart()}:${relation.kind}:${target}`;
      evidence.push({
        id,
        filePath: file.path,
        startLine,
        endLine,
        snippet: relation.node.getText(),
      });
      edges.push({
        id,
        source: file.path,
        target,
        kind: relation.kind,
        confidence: "confirmed",
        evidenceId: id,
      });
    }
    unresolved += source
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(
        (call) => call.getExpression().getKind() === SyntaxKind.ImportKeyword,
      ).length;
  }
  progress?.("symbols");
  const unresolvedCalls = addSymbolsAndCalls(project, paths, {
    nodes,
    edges,
    evidence,
  });
  progress?.("frameworks");
  addReactEvents(project, paths, { nodes, edges, evidence }, files);
  unresolved += addNextEntrypoints(project, paths, files, {
    nodes,
    edges,
    evidence,
  });
  addPrismaAccess(project, paths, { nodes, edges, evidence });
  unresolved += addHttpRelationships(project, paths, files, {
    nodes,
    edges,
    evidence,
  });
  return {
    nodes,
    edges,
    evidence,
    unresolved,
    unresolvedCalls,
    notice: `Static imports, references, resolved calls, recognized React event attributes, Next.js page entries, selected Express and Next.js routes, literal fetch requests and recognized Prisma access are included. HTTP matches are heuristic; static relationships are not runtime traces. Dynamic routes, dynamic URLs and dispatch may be unresolved. ${configNotice}`,
  };
}
