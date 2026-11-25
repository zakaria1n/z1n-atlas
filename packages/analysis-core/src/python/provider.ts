import type { GraphEvidence } from "@z1n/contracts";
import {
  addUnresolvedLocation,
  type GraphParts,
  type SourceLocation,
} from "../framework-graph";
import type { HttpRequestFact, HttpRouteFact } from "../http-match";
import { lineOf, parsePythonFiles, spanOf, type ParsedPython } from "./parser";
import { foldConstants, walkPython } from "./walk";
import {
  emptyAnalysis,
  type LanguageAnalysis,
  type PyCall,
  type PyClass,
  type PyDef,
  type PyExpr,
  type PyModule,
} from "./types";

const httpVerbs = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);
const sessionAnnotations = new Set([
  "Session",
  "Database",
  "AsyncSession",
  "scoped_session",
]);
const sessionNames = new Set(["session", "db"]);
const sessionOperations = new Set([
  "get",
  "add",
  "add_all",
  "scalar",
  "scalars",
  "query",
  "delete",
  "execute",
]);
/** Operations that read rows; everything else the session exposes writes. */
const sessionReadOperations = new Set([
  "get",
  "scalar",
  "scalars",
  "query",
  "execute",
]);
/** Transaction boundaries: they change no row themselves but prove persistence. */
const sessionTransactionOperations = new Set(["flush", "commit", "rollback"]);
const pythonClients = new Set(["requests", "httpx"]);
const clientVerbs = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "request",
]);

/** Joins a router prefix and a route path the way a framework mounts them. */
function joinPath(prefix: string, path: string): string {
  const joined = `${prefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  return joined.length > 1 ? joined.replace(/\/$/, "") : "/";
}

type PythonFile = {
  module: PyModule;
  parsed: ParsedPython;
  /** Module-level bindings: defined or imported names. */
  defs: Map<string, PyDef>;
  classes: Map<string, PyClass>;
  /** name -> imported target: the file and the name to look up there. */
  imports: Map<string, { path: string; name: string }>;
  /** Names imported from the requests or httpx client libraries. */
  clients: Set<string>;
  /** Import statements that stayed unresolved inside the project. */
  unresolvedImports: {
    start: number;
    end: number;
    text: string;
    reason: string;
  }[];
  modelClasses: Set<string>;
};

type Analysis = {
  files: Map<string, PythonFile>;
  graph: GraphParts;
  routes: HttpRouteFact[];
  requests: HttpRequestFact[];
  unresolved: number;
  unresolvedCalls: number;
};

export async function analyzePython(
  files: { path: string; content: string }[],
): Promise<LanguageAnalysis> {
  if (!files.length) return emptyAnalysis();
  const parsed = await parsePythonFiles(files);
  const analysis: Analysis = {
    files: new Map(),
    graph: { nodes: [], edges: [], evidence: [], unresolvedItems: [] },
    routes: [],
    requests: [],
    unresolved: 0,
    unresolvedCalls: 0,
  };
  for (const item of parsed) {
    const pyModule = walkPython(item);
    const file: PythonFile = {
      module: pyModule,
      parsed: item,
      defs: new Map(),
      classes: new Map(),
      imports: new Map(),
      clients: new Set(),
      unresolvedImports: [],
      modelClasses: new Set(),
    };
    for (const def of pyModule.defs)
      if (!def.className) file.defs.set(def.name, def);
    for (const entry of pyModule.classes) file.classes.set(entry.name, entry);
    for (const entry of pyModule.imports) {
      const first = (entry.module ?? entry.names[0]?.name ?? "").split(".")[0];
      if (pythonClients.has(first)) file.clients.add(first);
    }
    analysis.files.set(item.path, file);
  }
  resolveImports(analysis);
  declareNodes(analysis);
  connectCalls(analysis);
  extractRoutes(analysis);
  extractDatabaseAccess(analysis);
  extractClientRequests(analysis);
  reportUnresolvedImports(analysis);
  return {
    parts: analysis.graph,
    routes: analysis.routes,
    requests: analysis.requests,
    unresolved: analysis.unresolved,
    unresolvedCalls: analysis.unresolvedCalls,
  };
}

function dirOf(path: string): string[] {
  return path.split("/").slice(0, -1);
}

/** The candidate file paths of a module path relative to a directory. */
function moduleCandidates(parts: string[]): string[] {
  const base = parts.join("/");
  return [`${base}.py`, `${base}/__init__.py`];
}

/**
 * Resolves import statements to files of the selection. Relative imports
 * follow the importer's package, absolute ones are searched from the root and
 * then from the importer's ancestors; imports whose first segment is not part
 * of the project stay unresolved silently, the way installed packages are.
 */
function resolveImports(analysis: Analysis): void {
  const roots = new Set(
    [...analysis.files.keys()].map((path) => path.split("/")[0]),
  );
  for (const file of analysis.files.values()) {
    for (const entry of file.module.imports) {
      if (entry.wildcard) continue;
      if (entry.statement === "from") {
        const target = resolveModulePath(
          analysis,
          file.module.path,
          entry.module ?? "",
          entry.level,
        );
        if (!target) {
          recordImportGap(analysis, file, entry, roots);
          continue;
        }
        const id = `${file.module.path}:${entry.start}:imports:${target}`;
        pushEdge(analysis.graph, {
          id,
          source: file.module.path,
          target,
          kind: "imports",
          confidence: "confirmed",
          evidenceId: evidence(
            analysis,
            file.module.path,
            entry.start,
            entry.end,
            id,
          ),
        });
        for (const { name, alias } of entry.names)
          file.imports.set(alias ?? name, { path: target, name });
      } else {
        // `import a.b.c` binds only its first segment.
        for (const { name, alias } of entry.names) {
          const first = name.split(".")[0];
          const target = resolveModulePath(
            analysis,
            file.module.path,
            first,
            entry.level,
          );
          if (target) {
            file.imports.set(alias ?? first, {
              path: target,
              name: "__module__",
            });
            const id = `${file.module.path}:${entry.start}:imports:${target}`;
            pushEdge(analysis.graph, {
              id,
              source: file.module.path,
              target,
              kind: "imports",
              confidence: "confirmed",
              evidenceId: evidence(
                analysis,
                file.module.path,
                entry.start,
                entry.end,
                id,
              ),
            });
          } else recordImportGap(analysis, file, entry, roots);
        }
      }
    }
  }
}

function recordImportGap(
  analysis: Analysis,
  file: PythonFile,
  entry: PyModule["imports"][number],
  roots: Set<string>,
): void {
  analysis.unresolved++;
  const first = (entry.module ?? entry.names[0]?.name ?? "").split(".")[0];
  // A missing import of something outside the repository is an installed
  // package; only gaps inside the project are reported.
  if (entry.level > 0 || (first && roots.has(first)))
    file.unresolvedImports.push({
      start: entry.start,
      end: entry.end,
      text: entry.text,
      reason: "This import does not resolve to a module in the analysis.",
    });
}

function resolveModulePath(
  analysis: Analysis,
  importerPath: string,
  modulePath: string,
  level: number,
): string | null {
  const rest = modulePath ? modulePath.split(".") : [];
  if (level > 0) {
    const dir = dirOf(importerPath);
    const base = dir.slice(0, dir.length - (level - 1));
    for (const candidate of moduleCandidates([...base, ...rest]))
      if (analysis.files.has(candidate)) return candidate;
    return null;
  }
  for (const candidate of moduleCandidates(rest))
    if (analysis.files.has(candidate)) return candidate;
  // Absolute imports can also address a module relative to an ancestor
  // package of the importer (src layouts and relocated packages).
  const dir = dirOf(importerPath);
  for (let up = 1; up < dir.length && up <= 6; up++) {
    const base = dir.slice(0, dir.length - up);
    for (const candidate of moduleCandidates([...base, ...rest]))
      if (analysis.files.has(candidate)) return candidate;
  }
  return null;
}

function declareNodes(analysis: Analysis): void {
  const { graph } = analysis;
  for (const [path, file] of analysis.files) {
    graph.nodes.push({ id: path, path, exports: file.module.exports });
    for (const def of file.module.defs) {
      graph.nodes.push({
        id: def.id,
        path,
        exports: [],
        kind: def.kind,
        name: def.name,
        startLine: lineOf(file.parsed, def.start),
        endLine: lineOf(file.parsed, def.end),
      });
      const container = def.className
        ? file.module.classes.find((entry) => entry.name === def.className)?.id
        : path;
      if (!container) continue;
      const id = def.className
        ? `${container}:contains:${def.id}`
        : `${path}:${def.start}:contains:${def.id}`;
      pushEdge(graph, {
        id,
        source: container,
        target: def.id,
        kind: "contains",
        confidence: "confirmed",
        evidenceId: evidence(analysis, path, def.start, def.end, id),
      });
    }
    for (const entry of file.module.classes) {
      graph.nodes.push({
        id: entry.id,
        path,
        exports: [],
        kind: "class",
        name: entry.name,
        startLine: lineOf(file.parsed, entry.start),
        endLine: lineOf(file.parsed, entry.end),
      });
      const id = `${path}:${entry.start}:contains:${entry.id}`;
      pushEdge(graph, {
        id,
        source: path,
        target: entry.id,
        kind: "contains",
        confidence: "confirmed",
        evidenceId: evidence(analysis, path, entry.start, entry.end, id),
      });
    }
  }
}

function locationOf(
  file: PythonFile,
  start: number,
  end: number,
): SourceLocation {
  const span = spanOf(file.parsed, start, end);
  return { filePath: file.module.path, start, ...span };
}

function evidence(
  analysis: Analysis,
  filePath: string,
  start: number,
  end: number,
  id: string,
): string {
  const file = analysis.files.get(filePath)!;
  const span = spanOf(file.parsed, start, end);
  const item: GraphEvidence = { id, filePath, ...span };
  if (!analysis.graph.evidence.some((existing) => existing.id === id))
    analysis.graph.evidence.push(item);
  return id;
}

function pushEdge(graph: GraphParts, edge: GraphParts["edges"][number]): void {
  graph.edges.push(edge);
}

/**
 * Resolves calls the way Python reads them: a bare name against the module's
 * definitions and imports, `self.x()` against the methods of the enclosing
 * class, and `module.x()` against the definitions of an imported module.
 */
function connectCalls(analysis: Analysis): void {
  for (const [path, file] of analysis.files) {
    for (const call of file.module.calls) {
      if (isFrameworkCall(file, call.callee)) continue;
      const target = resolveCallTarget(analysis, file, call);
      if (!target) {
        analysis.unresolvedCalls++;
        continue;
      }
      const owner = call.owner >= 0 ? file.module.defs[call.owner].id : path;
      const id = `${path}:${call.start}:calls:${target}`;
      pushEdge(analysis.graph, {
        id,
        source: owner,
        target,
        kind: "calls",
        confidence: "confirmed",
        evidenceId: evidence(analysis, path, call.start, call.end, id),
      });
    }
  }
}

/** Router decorators and include_router calls are handled by their own passes. */
function isFrameworkCall(file: PythonFile, callee: PyExpr): boolean {
  if (callee.kind !== "attribute") return false;
  const receiver = callee.receiverText!.split(".")[0];
  if (callee.name === "include_router") return true;
  return Boolean(
    httpVerbs.has(callee.name ?? "") &&
    (file.module.routers.has(receiver) || file.module.apps.has(receiver)),
  );
}

function resolveCallTarget(
  analysis: Analysis,
  file: PythonFile,
  call: PyCall,
): string | null {
  const callee = call.callee;
  if (callee.kind === "identifier") {
    const local = file.defs.get(callee.name!) ?? file.classes.get(callee.name!);
    if (local) return local.id;
    const imported = file.imports.get(callee.name!);
    if (imported && imported.name !== "__module__") {
      const target = analysis.files.get(imported.path);
      return (
        target?.defs.get(imported.name)?.id ??
        target?.classes.get(imported.name)?.id ??
        null
      );
    }
    return null;
  }
  const receiver = callee.receiverText!;
  const attribute = callee.name!;
  if (receiver === "self") {
    const owner = call.owner >= 0 ? file.module.defs[call.owner] : null;
    const className = owner?.className;
    if (!className) return null;
    const method = file.module.defs.find(
      (def) => def.className === className && def.name === attribute,
    );
    return method?.id ?? null;
  }
  // `import a.b.c` exposes the whole chain through the first segment.
  const moduleBinding = file.imports.get(receiver.split(".")[0]);
  if (moduleBinding && moduleBinding.name === "__module__") {
    const target = analysis.files.get(moduleBinding.path);
    const segments = receiver.split(".");
    if (segments.length === 1 && target)
      return (
        target.defs.get(attribute)?.id ??
        target.classes.get(attribute)?.id ??
        null
      );
  }
  return null;
}

/** Extracts FastAPI routes from decorators, composing router prefixes. */
function extractRoutes(analysis: Analysis): void {
  const { graph } = analysis;
  type Mount = { child: string; prefix: string; start: number };
  const mounts = new Map<string, Mount[]>();
  const declared = new Map<string, string>();
  for (const [routerPath, file] of analysis.files) {
    for (const [name, router] of file.module.routers)
      declared.set(`${routerPath}#${name}`, router.prefix ?? "");
    for (const name of file.module.apps)
      declared.set(`${routerPath}#${name}`, "");
  }
  for (const [, file] of analysis.files) {
    for (const include of file.module.includes) {
      const host = localVar(file, include.host);
      if (!host) continue;
      const child = resolveChildRouter(file, include.child);
      if (!child || !declared.has(child)) {
        analysis.unresolved++;
        addUnresolvedLocation(
          analysis.graph,
          locationOf(file, include.child.start, include.child.end),
          "route",
          "This router could not be resolved to an analyzed module.",
        );
        continue;
      }
      const list = mounts.get(host) ?? [];
      list.push({ child, prefix: include.prefix ?? "", start: include.start });
      mounts.set(host, list);
    }
  }
  /**
   * The prefixes a router is served under: its own declaration, and every
   * chain of include_router mounts that reaches it from an application.
   */
  function prefixesFor(variable: string): string[] {
    const results = new Set<string>([declared.get(variable) ?? ""]);
    const seen = new Set<string>([variable]);
    const walk = (current: string, prefix: string) => {
      for (const mount of mounts.get(current) ?? []) {
        if (seen.has(mount.child)) continue;
        seen.add(mount.child);
        const mounted = joinPath(prefix, mount.prefix);
        results.add(joinPath(mounted, declared.get(mount.child) ?? ""));
        walk(mount.child, joinPath(mounted, declared.get(mount.child) ?? ""));
      }
    };
    walk(variable, declared.get(variable) ?? "");
    return [...results];
  }
  for (const [path, file] of analysis.files) {
    for (const def of file.module.defs) {
      for (const decorator of def.decorators) {
        if (!decorator.verb || !httpVerbs.has(decorator.verb)) continue;
        // The receiver of `@router.get(...)` is the router variable itself.
        const variable = localVar(file, decorator.receiver.split(".")[0]);
        if (!variable) continue;
        const routePath = decorator.args[0]
          ? foldConstants(decorator.args[0], file.module.constants)
          : null;
        if (
          routePath === null ||
          (routePath !== "" && !routePath.startsWith("/"))
        ) {
          analysis.unresolved++;
          addUnresolvedLocation(
            graph,
            locationOf(file, decorator.start, decorator.end),
            "route",
            `The path of this ${decorator.verb} route is not a literal value.`,
          );
          continue;
        }
        for (const prefix of prefixesFor(variable)) {
          const full = joinPath(prefix, routePath);
          const method = decorator.verb.toUpperCase();
          const routeName = `${method} ${full}`;
          const nodeId = `${path}#route:${decorator.start}:${encodeURIComponent(full)}`;
          const evidenceId = evidence(
            analysis,
            path,
            decorator.start,
            decorator.end,
            `${nodeId}:evidence`,
          );
          graph.nodes.push({
            id: nodeId,
            path,
            exports: [],
            kind: "route",
            name: routeName,
            startLine: lineOf(file.parsed, decorator.start),
            endLine: lineOf(file.parsed, decorator.end),
          });
          pushEdge(graph, {
            id: `${nodeId}:contains`,
            source: path,
            target: nodeId,
            kind: "contains",
            confidence: "framework",
            evidenceId,
          });
          pushEdge(graph, {
            id: `${nodeId}:handles:${def.id}`,
            source: nodeId,
            target: def.id,
            kind: "handles",
            confidence: "framework",
            evidenceId,
          });
          analysis.routes.push({ nodeId, path: full, method, evidenceId });
        }
      }
    }
  }
}

/** The router variable a receiver text names, following import aliases. */
function localVar(file: PythonFile, receiver: string): string | null {
  if (!receiver.includes(".") && file.module.routers.has(receiver))
    return `${file.module.path}#${receiver}`;
  if (!receiver.includes(".") && file.module.apps.has(receiver))
    return `${file.module.path}#${receiver}`;
  const binding = file.imports.get(receiver);
  if (binding) return `${binding.path}#${binding.name}`;
  return null;
}

/** Resolves the router passed to include_router to its host-file variable. */
function resolveChildRouter(file: PythonFile, child: PyExpr): string | null {
  if (child.kind === "identifier") return localVar(file, child.name!);
  if (child.kind === "attribute" && child.receiverText) {
    const binding = file.imports.get(child.receiverText.split(".")[0]);
    if (binding) return `${binding.path}#${child.name}`;
    return localVar(file, child.name!);
  }
  return null;
}

/**
 * Recognizes SQLAlchemy models and the session operations around them: reads
 * and writes are named for what they do to a model, and flush, commit and
 * rollback mark the transaction boundaries that prove persistence. Nothing
 * executes; every operation keeps its call site as evidence.
 */
function extractDatabaseAccess(analysis: Analysis): void {
  for (const [, file] of analysis.files)
    for (const entry of file.module.classes)
      if (
        entry.superclasses.some((base) =>
          ["Base", "DeclarativeBase"].includes(base.split(".").at(-1)!),
        ) ||
        entry.hasTableName
      )
        file.modelClasses.add(entry.name);
  for (const [path, file] of analysis.files) {
    for (const call of file.module.calls) {
      if (call.callee.kind !== "attribute") continue;
      const method = call.callee.name!;
      const isTransaction = sessionTransactionOperations.has(method);
      const isModelOperation = sessionOperations.has(method);
      if (!isTransaction && !isModelOperation) continue;
      const owner = call.owner >= 0 ? file.module.defs[call.owner] : null;
      const receiver = call.callee.receiverText!.split(".")[0];
      const annotated = owner?.parameters.some(
        (parameter) =>
          parameter.name === receiver &&
          parameter.annotation !== undefined &&
          sessionAnnotations.has(
            parameter.annotation
              .replace(/\[.*\]/, "")
              .split(".")
              .at(-1)!,
          ),
      );
      if (!sessionNames.has(receiver) && !annotated) continue;
      const id = `${path}#database:${call.start}`;
      const evidenceId = evidence(
        analysis,
        path,
        call.start,
        call.end,
        `${id}:evidence`,
      );
      // A transaction boundary changes no row by itself, so it names only the
      // operation and never claims a model or a successful outcome.
      if (isTransaction) {
        analysis.graph.nodes.push({
          id,
          path,
          exports: [],
          kind: "database",
          name: `SQLAlchemy ${method}`,
          startLine: lineOf(file.parsed, call.start),
          endLine: lineOf(file.parsed, call.end),
        });
        pushEdge(analysis.graph, {
          id: `${id}:access`,
          source: owner ? owner.id : path,
          target: id,
          kind: "database-access",
          confidence: "framework",
          evidenceId,
        });
        continue;
      }
      const model = resolveModelArgument(file, call.args[0], call.owner);
      if (!model) continue;
      const modelClass =
        file.classes.get(model) ?? importedClass(analysis, file, model);
      if (!modelClass) continue;
      analysis.graph.nodes.push({
        id,
        path,
        exports: [],
        kind: "database",
        name: `SQLAlchemy ${sessionReadOperations.has(method) ? "read" : "write"} ${method} ${model}`,
        startLine: lineOf(file.parsed, call.start),
        endLine: lineOf(file.parsed, call.end),
      });
      pushEdge(analysis.graph, {
        id: `${id}:access`,
        source: owner ? owner.id : path,
        target: id,
        kind: "database-access",
        confidence: "framework",
        evidenceId,
      });
      const modelRef = findModelReference(call.args[0]);
      pushEdge(analysis.graph, {
        id: `${id}:references:${modelClass.id}`,
        source: id,
        target: modelClass.id,
        kind: "references",
        confidence: "framework",
        evidenceId: modelRef
          ? evidence(
              analysis,
              path,
              modelRef.start,
              modelRef.end,
              `${id}:model`,
            )
          : evidenceId,
      });
    }
  }
}

function importedClass(
  analysis: Analysis,
  file: PythonFile,
  name: string,
): PyClass | null {
  const binding = file.imports.get(name);
  if (!binding) return null;
  return analysis.files.get(binding.path)?.classes.get(binding.name) ?? null;
}

/** The first model-name reference inside an argument expression. */
function findModelReference(
  expr: PyExpr | undefined,
): { start: number; end: number } | null {
  if (!expr) return null;
  if (expr.kind === "identifier") return { start: expr.start, end: expr.end };
  if (expr.kind === "call") return findModelReference(expr.args?.[0]);
  return null;
}

/**
 * The model a session operation touches: a class name passed directly, the
 * variable a constructor result was bound to, a constructor call handed to
 * session.add, or the argument of select().
 */
function resolveModelArgument(
  file: PythonFile,
  arg: PyExpr | undefined,
  owner: number,
): string | null {
  if (!arg) return null;
  if (arg.kind === "identifier") {
    const name = arg.name!;
    if (file.classes.has(name) || file.imports.has(name)) return name;
    const binding = file.module.bindings.find(
      (item) => item.owner === owner && item.name === name,
    );
    return binding ? binding.constructor.split(".").at(-1)! : null;
  }
  if (arg.kind === "call") {
    if (arg.receiverText === "select" && arg.args?.length)
      return resolveModelArgument(file, arg.args[0], owner);
    // session.add(Model(...)) constructs the row it stores.
    if (arg.receiverText && /^[A-Za-z_][\w.]*$/.test(arg.receiverText))
      return arg.receiverText.split(".").at(-1)!;
  }
  return null;
}

/** Literal requests made with the requests or httpx client libraries. */
function extractClientRequests(analysis: Analysis): void {
  for (const [path, file] of analysis.files) {
    for (const call of file.module.calls) {
      if (call.callee.kind !== "attribute") continue;
      const verb = call.callee.name!;
      if (!clientVerbs.has(verb)) continue;
      const base = call.callee.receiverText!.split(/[.(]/)[0];
      if (!file.clients.has(base)) continue;
      const url =
        verb === "request"
          ? foldConstants(call.args[1], file.module.constants)
          : foldConstants(call.args[0], file.module.constants);
      const method =
        verb === "request"
          ? foldConstants(call.args[0], file.module.constants)
          : verb.toUpperCase();
      if (!url || !method || !url.startsWith("/")) {
        analysis.unresolved++;
        addUnresolvedLocation(
          analysis.graph,
          locationOf(file, call.start, call.end),
          "request",
          `The address of this ${verb} request is not a literal path.`,
        );
        continue;
      }
      const id = `${path}#http:${call.start}`;
      const evidenceId = evidence(
        analysis,
        path,
        call.start,
        call.end,
        `${id}:evidence`,
      );
      analysis.graph.nodes.push({
        id,
        path,
        exports: [],
        kind: "http-call",
        name: `${method.toUpperCase()} ${url}`,
        startLine: lineOf(file.parsed, call.start),
        endLine: lineOf(file.parsed, call.end),
      });
      pushEdge(analysis.graph, {
        id: `${id}:requests`,
        source: call.owner >= 0 ? file.module.defs[call.owner].id : path,
        target: id,
        kind: "requests",
        confidence: "framework",
        evidenceId,
      });
      analysis.requests.push({
        nodeId: id,
        url,
        method: method.toUpperCase(),
        evidenceId,
        location: locationOf(file, call.start, call.end),
      });
    }
  }
}

function reportUnresolvedImports(analysis: Analysis): void {
  for (const [, file] of analysis.files)
    for (const gap of file.unresolvedImports)
      addUnresolvedLocation(
        analysis.graph,
        locationOf(file, gap.start, gap.end),
        "import",
        gap.reason,
      );
}
