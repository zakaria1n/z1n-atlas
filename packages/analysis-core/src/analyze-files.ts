import { Project, SyntaxKind, ts, type SourceFile } from "ts-morph";
import { addNextEntrypoints } from "./next-entrypoints";
import { addPrismaAccess } from "./prisma-access";
import { addHttpRelationships } from "./http-relationships";
import { addSymbolsAndCalls } from "./symbols-and-calls";
import { compilerOptions } from "./compiler-options";
import { addReactRelationships } from "./react-relationships";
import { createManifestLookup, type ManifestLookup } from "./next-manifest";
import { createModuleResolver } from "./module-resolution";
import { analyzePython } from "./python/provider";
import {
  matchHttp,
  type HttpRequestFact,
  type HttpRouteFact,
} from "./http-match";
import type { CodeGraph } from "@z1n/contracts";
import {
  addUnresolved,
  type AnalysisContext,
  type GraphParts,
  type SymbolContext,
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
const pythonSource = /\.py$/i;
const identifierName = /^[A-Za-z_$][\w$]*$/;
const relativeImport = /^\.{1,2}\//;

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
      for (const node of [
        ...nodes.identifiers,
        ...nodes.calls,
        ...nodes.callVariables,
        ...nodes.declarations,
        ...nodes.jsxAttributes,
        ...nodes.jsxElements,
        ...nodes.anonymous.map((item) => item.node),
      ])
        remember(node);
      return nodes;
    });
  });
}

export type AnalysisStage =
  "parsing" | "imports" | "symbols" | "frameworks" | "validating";
export async function analyzeFiles(
  files: AnalyzerFile[],
  progress?: (stage: AnalysisStage) => void,
): Promise<CodeGraph> {
  progress?.("parsing");
  const scripts = files.filter((file) => script.test(file.path));
  const javascript = analyzeJavaScript(scripts, files, progress);
  // Python files are analyzed by the language provider when the selection
  // contains any; a JavaScript-only selection never loads that parser.
  const pythonSources = files.filter((file) => pythonSource.test(file.path));
  const python = pythonSources.length
    ? await analyzePython(pythonSources)
    : {
        parts: { nodes: [], edges: [], evidence: [], unresolvedItems: [] },
        routes: [],
        requests: [],
        unresolved: 0,
        unresolvedCalls: 0,
      };
  const graph: GraphParts = javascript.graph;
  for (const key of [
    "nodes",
    "edges",
    "evidence",
    "unresolvedItems",
  ] as const) {
    for (const item of python.parts[key]) {
      const list = graph[key] as { id: string }[];
      if (!list.some((existing) => existing.id === item.id))
        list.push(item as { id: string });
    }
  }
  const unmatched = matchHttp(
    [...javascript.requests, ...python.requests],
    [...javascript.routes, ...python.routes],
    graph,
  );
  return {
    nodes: graph.nodes,
    edges: graph.edges,
    evidence: graph.evidence,
    unresolved: javascript.unresolved + python.unresolved + unmatched,
    unresolvedCalls: javascript.unresolvedCalls + python.unresolvedCalls,
    unresolvedItems: graph.unresolvedItems.length
      ? graph.unresolvedItems
      : undefined,
    notice: `Static imports, references, resolved calls, recognized React event attributes and rendered components, Next.js page entries, selected Express, Fastify and Next.js routes including inline handlers, literal fetch requests, requests through functions that forward their arguments to fetch, axios requests, Python modules, imports, calls and classes, FastAPI routes with composed router prefixes, SQLAlchemy models and session operations, literal requests/httpx calls, and recognized Prisma access are included. Client requests are matched against analyzed routes by path pattern and method, including across JavaScript and Python files; that matching is heuristic. Requests, routes and handlers that could not be resolved are listed. Static relationships are not runtime traces. ${javascript.configNotice}`,
  };
}

/** The JavaScript and TypeScript half of the analysis, unchanged by the language dispatch. */
function analyzeJavaScript(
  scripts: AnalyzerFile[],
  files: AnalyzerFile[],
  progress?: (stage: AnalysisStage) => void,
): {
  graph: GraphParts;
  routes: HttpRouteFact[];
  requests: HttpRequestFact[];
  unresolved: number;
  unresolvedCalls: number;
  configNotice: string;
} {
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
  const known = new Set(files.map((file) => file.path));
  const graph: GraphParts = {
    nodes: [],
    edges: [],
    evidence: [],
    unresolvedItems: [],
  };
  const manifests: ManifestLookup = createManifestLookup(files);
  // React conventions are only read where the file proves it is React code.
  const reactFiles = new Set(
    sources
      .filter(
        ({ path, source }) =>
          /\.[jt]sx$/i.test(path) &&
          (source
            .getImportDeclarations()
            .some(
              (declaration) =>
                declaration.getModuleSpecifierValue() === "react",
            ) ||
            manifests.react(path) !== null),
      )
      .map(({ path }) => path),
  );
  const context: AnalysisContext = {
    files,
    sources,
    paths,
    graph,
    names,
    manifests,
    reactFiles,
  };
  for (const { path, source } of sources)
    graph.nodes.push({ id: path, path, exports: exportedNames(source) });
  let unresolved = 0;
  progress?.("imports");
  for (const { path, source, calls } of sources) {
    const relations = [
      ...source.getImportDeclarations().map((node) => ({
        node,
        specifier: node.getModuleSpecifierValue(),
        kind: "imports" as const,
      })),
      ...source.getExportDeclarations().flatMap((node) => {
        const specifier = node.getModuleSpecifierValue();
        return specifier
          ? [{ node, specifier, kind: "re-exports" as const }]
          : [];
      }),
    ].map((relation) => ({
      ...relation,
      target: resolveModule(relation.specifier, path),
    }));
    for (const relation of relations) {
      if (!relation.target || !paths.has(relation.target)) {
        unresolved++;
        // Packages are expected to be outside the analysis; a relative
        // import that leads nowhere is a gap worth showing.
        if (relativeImport.test(relation.specifier))
          addUnresolved(
            relation.node,
            context,
            "import",
            known.has(relation.target ?? "")
              ? "This file is indexed but was not selected for analysis."
              : "This import does not resolve to a file in the index.",
          );
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
  const { symbols, unresolvedCalls, callTargets } = addSymbolsAndCalls(context);
  const symbolContext: SymbolContext = {
    ...context,
    symbols,
    callTargets,
  };
  progress?.("frameworks");
  addReactRelationships(symbolContext);
  unresolved += addNextEntrypoints(symbolContext);
  addPrismaAccess(symbolContext);
  const http = addHttpRelationships(symbolContext);
  unresolved += http.unresolved;
  return {
    graph,
    routes: http.routes,
    requests: http.requests,
    unresolved,
    unresolvedCalls,
    configNotice,
  };
}
