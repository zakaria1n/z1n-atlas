import type { CodeGraph } from "@z1n/contracts";

/**
 * Loads the real ForceAtlas2 supervisor (graphology-layout-forceatlas2/worker)
 * through a minimal CJS shim in the browser, bypassing bundler resolution of
 * the package's unpublished subpath. The supervisor spawns the genuine
 * web worker from the vendored webworker factory — the same bounded-worker
 * lifecycle the reference renderer uses.
 */
export type Fa2Supervisor = new (
  graph: unknown,
  params?: { settings?: unknown },
) => {
  isRunning(): boolean;
  start(): void;
  stop(): void;
  kill(): void;
  on?(event: string, handler: () => void): void;
};

const fetchText = async (url: string) =>
  fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.text();
  });

function evaluateCjs(
  source: string,
  requireModule: (name: string) => unknown,
): unknown {
  const moduleShim = { exports: {} as unknown };
  const factory = new Function(
    "require",
    "module",
    "exports",
    `${source}\n//# sourceURL=fa2-cjs`,
  );
  factory(requireModule, moduleShim, moduleShim.exports);
  return moduleShim.exports;
}

// graphology-utils/is-graph exports the predicate as the module root.
const isGraph = (value: unknown) =>
  Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { order?: number }).order === "number" &&
    typeof (value as { addNode?: unknown }).addNode === "function",
  );
const SHIMS = {
  "graphology-utils/is-graph": isGraph,
  "graphology-utils/getters": {
    // Graphology's getter factory returns { fromEntry } closures over the
    // requested attribute name (or over the user-supplied function).
    createEdgeWeightGetter: (getter?: unknown) => ({
      fromEntry:
        typeof getter === "function"
          ? getter
          : (_edge: unknown, data: { [key: string]: unknown }) =>
              (data ?? {})[(getter as string) ?? "weight"] ?? 1,
    }),
    createNodeValueGetter: (getter?: unknown) => ({
      fromEntry:
        typeof getter === "function"
          ? getter
          : (_node: unknown, data: { [key: string]: unknown }) =>
              (data ?? {})[(getter as string) ?? "label"],
    }),
  },
};

export async function loadFa2Supervisor(
  baseUrl: string,
): Promise<Fa2Supervisor> {
  const [
    supervisorSource,
    defaultsSource,
    helpersSource,
    webworkerSource,
    iterateSource,
  ] = await Promise.all([
    fetchText(`${baseUrl}/fa2-supervisor.js`),
    fetchText(`${baseUrl}/fa2-defaults.js`),
    fetchText(`${baseUrl}/fa2-helpers.js`),
    fetchText(`${baseUrl}/fa2-webworker.js`),
    fetchText(`${baseUrl}/fa2-iterate.js`),
  ]);
  const cache = new Map<string, unknown>();
  const load: (name: string, source?: string) => unknown = (
    name: string,
    source?: string,
  ): unknown => {
    if (!cache.has(name))
      cache.set(
        name,
        evaluateCjs(source ?? "", (required: string) => load(required)),
      );
    return cache.get(name);
  };
  load("./defaults.js", defaultsSource);
  load("./helpers.js", helpersSource);
  load("./iterate.js", iterateSource);
  load("./webworker.js", webworkerSource);
  for (const [name, shim] of Object.entries(SHIMS)) cache.set(name, shim);
  return evaluateCjs(supervisorSource, (name: string) => {
    if (cache.has(name)) return cache.get(name);
    throw new Error(`fa2 supervisor shim: unexpected require "${name}"`);
  }) as Fa2Supervisor;
}

export type Fa2BenchSource = CodeGraph;
