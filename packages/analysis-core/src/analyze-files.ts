import { Project, SyntaxKind, ts, type SourceFile } from "ts-morph";
import { addNextEntrypoints } from "./next-entrypoints";
import { addPrismaAccess } from "./prisma-access";
import { addHttpRelationships } from "./http-relationships";
import { addSymbolsAndCalls } from "./symbols-and-calls";
import { compilerOptions } from "./compiler-options";
import { addReactEvents } from "./react-events";
import { createManifestLookup, type ManifestLookup } from "./next-manifest";
import { createModuleResolver } from "./module-resolution";
import type { CodeGraph } from "@z1n/contracts";
import type {
  AnalysisContext,
  GraphParts,
  SymbolContext,
} from "./framework-graph";
import {
  candidateNames,
  collectSourceNodes,
  hasExportModifier,
  localExportNames,
  type SourceNodes,
  type SymbolNames,
} from "./source-nodes";

export type AnalyzerFile = { path: string; content: string };
const script = /\.[cm]?[jt]sx?$/i;
const identifierName = /^[A-Za-z_$][\w$]*$/;

function exportedNames(source: SourceFile): string[] {
  const localExports = localExportNames(source);
  const names: string[] = [];
  for (const statement of source.compilerNode.statements) {
    if (ts.isVariableStatement(statement)) {
      if (!hasExportModifier(statement, statement)) continue;
      for (const { name } of statement.declarationList.declarations)
        if (ts.isIdentifier(name) && identifierName.test(name.text))
          names.push(name.text);
      continue;
    }
    const name =
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
        ? statement.name
        : undefined;
    if (!name) continue;
    if (hasExportModifier(statement, statement) || localExports.has(name.text))
      names.push(name.text);
  }
  return [...new Set(names)].sort();
}

/**
 * Walks each file once and keeps only the nodes the passes use. Collecting
 * inside a forget block releases the wrappers created for every other node
 * as soon as the file is done, which keeps memory flat on large selections.
 */
function collectSources(
  project: Project,
  files: AnalyzerFile[],
  names: SymbolNames,
): SourceNodes[] {
  return files.map((file) => {
    const source = project.getSourceFileOrThrow(`/workspace/${file.path}`);
    return project.forgetNodesCreatedInBlock((remember) => {
      const nodes = collectSourceNodes(source, names);
      for (const group of [
        nodes.identifiers,
        nodes.calls,
        nodes.callVariables,
        nodes.declarations,
        nodes.jsxAttributes,
      ])
        for (const node of group) remember(node);
      return nodes;
    });
  });
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
  const names = candidateNames(
    scripts.map((file) =>
      project.getSourceFileOrThrow(`/workspace/${file.path}`),
    ),
  );
  const sources = collectSources(project, scripts, names);
  const resolveModule = createModuleResolver(files, options);
  const paths = new Set(scripts.map((file) => file.path));
  const graph: GraphParts = { nodes: [], edges: [], evidence: [] };
  const manifests: ManifestLookup = createManifestLookup(files);
  const context: AnalysisContext = {
    files,
    sources,
    paths,
    graph,
    names,
    manifests,
  };
  for (const { path, source } of sources)
    graph.nodes.push({ id: path, path, exports: exportedNames(source) });
  let unresolved = 0;
  progress?.("imports");
  for (const { path, source, calls } of sources) {
    const relations = [
      ...source.getImportDeclarations().map((node) => ({
        node,
        target: resolveModule(node.getModuleSpecifierValue(), path),
        kind: "imports" as const,
      })),
      ...source.getExportDeclarations().flatMap((node) => {
        const specifier = node.getModuleSpecifierValue();
        return specifier
          ? [
              {
                node,
                target: resolveModule(specifier, path),
                kind: "re-exports" as const,
              },
            ]
          : [];
      }),
    ];
    for (const relation of relations) {
      if (!relation.target || !paths.has(relation.target)) {
        unresolved++;
        continue;
      }
      const target = relation.target;
      const startLine = relation.node.getStartLineNumber();
      const endLine = relation.node.getEndLineNumber();
      const id = `${path}:${relation.node.getStart()}:${relation.kind}:${target}`;
      graph.evidence.push({
        id,
        filePath: path,
        startLine,
        endLine,
        snippet: relation.node.getText(),
      });
      graph.edges.push({
        id,
        source: path,
        target,
        kind: relation.kind,
        confidence: "confirmed",
        evidenceId: id,
      });
    }
    unresolved += calls.filter(
      (call) => call.getExpression().getKind() === SyntaxKind.ImportKeyword,
    ).length;
  }
  progress?.("symbols");
  const { symbols, unresolvedCalls } = addSymbolsAndCalls(context);
  const symbolContext: SymbolContext = { ...context, symbols };
  progress?.("frameworks");
  addReactEvents(symbolContext);
  unresolved += addNextEntrypoints(symbolContext);
  addPrismaAccess(symbolContext);
  unresolved += addHttpRelationships(symbolContext);
  return {
    nodes: graph.nodes,
    edges: graph.edges,
    evidence: graph.evidence,
    unresolved,
    unresolvedCalls,
    notice: `Static imports, references, resolved calls, recognized React event attributes, Next.js page entries, selected Express and Next.js routes, literal fetch requests and recognized Prisma access are included. HTTP matches are heuristic; static relationships are not runtime traces. Dynamic routes, dynamic URLs and dispatch may be unresolved. ${configNotice}`,
  };
}
