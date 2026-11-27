import path from "node:path";
import type { CodeGraph } from "@z1n/contracts";
import { journeyKinds } from "../journey/journey-kinds";

type Source = { path: string; content: string };

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".rb": "Ruby",
  ".php": "PHP",
};

// Manifest markers are source facts: a dependency declared in a manifest
// read from the selection proves the declaration (not that it is used).
const FRAMEWORK_MARKERS: { file: RegExp; framework: string; marker: RegExp }[] =
  [
    {
      file: /(^|\/)package\.json$/,
      framework: "Next.js",
      marker: /"next"\s*:/,
    },
    { file: /(^|\/)package\.json$/, framework: "React", marker: /"react"\s*:/ },
    { file: /(^|\/)package\.json$/, framework: "Vue", marker: /"vue"\s*:/ },
    {
      file: /(^|\/)package\.json$/,
      framework: "Express",
      marker: /"express"\s*:/,
    },
    {
      file: /(^|\/)package\.json$/,
      framework: "Fastify",
      marker: /"fastify"\s*:/,
    },
    {
      file: /(^|\/)package\.json$/,
      framework: "NestJS",
      marker: /"@nestjs\/core"\s*:/,
    },
    {
      file: /(^|\/)package\.json$/,
      framework: "Prisma",
      marker: /"@prisma\/client"\s*:/,
    },
    {
      file: /(^|\/)requirements\.txt$/,
      framework: "FastAPI",
      marker: /fastapi/i,
    },
    { file: /(^|\/)requirements\.txt$/, framework: "Flask", marker: /flask/i },
    {
      file: /(^|\/)requirements\.txt$/,
      framework: "Django",
      marker: /django/i,
    },
    {
      file: /(^|\/)requirements\.txt$/,
      framework: "SQLAlchemy",
      marker: /sqlalchemy/i,
    },
    {
      file: /(^|\/)pyproject\.toml$/,
      framework: "FastAPI",
      marker: /fastapi/i,
    },
    {
      file: /(^|\/)schema\.prisma$/,
      framework: "Prisma",
      marker: /model\s+\w+/,
    },
  ];

const MAX_TREE_LINES = 60;
const MAX_TREE_DEPTH = 3;
const MAX_HOTSPOTS = 8;
const MAX_ROUTES = 12;
const MAX_ENTRY_POINTS = 12;
export type RepositoryContext = {
  identity: string;
  facts: {
    selectedFiles: number;
    analyzedFiles: number;
    symbols: number;
    relationships: number;
    unresolvedCalls: number;
    languages: { language: string; files: number }[];
    frameworks: string[];
    manifests: string[];
    routes: string[];
    truncatedRoutes: boolean;
    routeHandlers: string[];
  };
  heuristics: {
    /** Structural inference from degree counts, not a business module. */
    hotspots: { name: string; path: string; kind: string; degree: number }[];
    folderTree: string;
  };
  limitations: string[];
};

export function buildRepositoryContext(
  identity: string,
  files: Source[],
  graph: CodeGraph,
): RepositoryContext {
  const analyzedFiles = new Set(
    graph.nodes
      .filter((node) => node.kind && node.kind !== "file")
      .map((node) => node.path),
  ).size;
  const languages = new Map<string, number>();
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION[path.extname(file.path)];
    if (language) languages.set(language, (languages.get(language) ?? 0) + 1);
  }
  const frameworks = new Set<string>();
  const manifests: string[] = [];
  for (const file of files) {
    if (!FRAMEWORK_MARKERS.some((marker) => marker.file.test(file.path)))
      continue;
    manifests.push(file.path);
    if (Buffer.byteLength(file.content) > 100_000) continue;
    for (const marker of FRAMEWORK_MARKERS)
      if (marker.file.test(file.path) && marker.marker.test(file.content))
        frameworks.add(marker.framework);
  }
  const routes = graph.nodes
    .filter((node) => node.kind === "route")
    .slice(0, MAX_ROUTES)
    .map((node) => node.name ?? node.path);
  const truncatedRoutes =
    graph.nodes.filter((node) => node.kind === "route").length > MAX_ROUTES;
  const handlerIds = new Set(
    graph.edges
      .filter(
        (edge) =>
          edge.kind && journeyKinds.has(edge.kind) && edge.kind !== "renders",
      )
      .map((edge) => edge.target),
  );
  const routeHandlers: string[] = [];
  for (const id of handlerIds) {
    if (routeHandlers.length >= MAX_ENTRY_POINTS) break;
    const node = graph.nodes.find((item) => item.id === id);
    if (node) routeHandlers.push(`${node.name ?? node.path} (${node.path})`);
  }
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const hotspots = graph.nodes
    .filter((node) => node.kind && node.kind !== "file")
    .map((node) => ({ node, degree: degree.get(node.id) ?? 0 }))
    .filter((item) => item.degree >= 3)
    .sort((left, right) => right.degree - left.degree)
    .slice(0, MAX_HOTSPOTS)
    .map(({ node, degree: value }) => ({
      name: node.name ?? node.path,
      path: node.path,
      kind: node.kind ?? "file",
      degree: value,
    }));
  const directories = new Map<string, number>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (
      let depth = 1;
      depth <= MAX_TREE_DEPTH && depth < parts.length;
      depth++
    ) {
      const dir = parts.slice(0, depth).join("/");
      directories.set(dir, (directories.get(dir) ?? 0) + 1);
    }
  }
  const treeLines = [...directories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_TREE_LINES)
    .map(([dir, count]) => `${dir}/ (${count} files)`);
  const folderTree = treeLines.join("\n");
  return {
    identity,
    facts: {
      selectedFiles: files.length,
      analyzedFiles,
      symbols: graph.nodes.filter((node) => node.kind && node.kind !== "file")
        .length,
      relationships: graph.edges.length,
      unresolvedCalls: graph.unresolvedCalls,
      languages: [...languages.entries()]
        .map(([language, count]) => ({ language, files: count }))
        .sort((left, right) => right.files - left.files),
      frameworks: [...frameworks].sort(),
      manifests,
      routes,
      truncatedRoutes,
      routeHandlers,
    },
    heuristics: { hotspots, folderTree },
    limitations: [
      "Relationships come from static analysis of the selected files and are not runtime traces.",
      `Coverage: ${analyzedFiles} of ${files.length} selected files produced symbols; unresolved calls: ${graph.unresolvedCalls}.`,
      "Framework names come from package manifests and prove declarations, not usage.",
      "Hotspots are degree-ranked structural inferences, not confirmed business modules.",
    ],
  };
}

/** Bounded overview for the model: facts first, heuristics labeled. */
export function contextOverview(context: RepositoryContext): string {
  const fact = context.facts;
  return [
    `Repository snapshot ${context.identity}: ${fact.selectedFiles} selected files, ${fact.analyzedFiles} analyzed, ${fact.symbols} symbols, ${fact.relationships} relationships.`,
    `Languages: ${fact.languages.map((item) => `${item.language} (${item.files})`).join(", ") || "unknown"}.`,
    `Frameworks (from manifests): ${fact.frameworks.join(", ") || "none detected"}. Manifests: ${fact.manifests.join(", ") || "none"}.`,
    `Routes (${fact.routes.length}${fact.truncatedRoutes ? "+, truncated" : ""}): ${fact.routes.join(", ") || "none"}.`,
    `STRUCTURAL INFERENCES (degree-ranked, not runtime proof): ${context.heuristics.hotspots.map((hotspot) => `${hotspot.name} [${hotspot.kind}, ${hotspot.degree} connections]`).join(", ") || "none"}.`,
    `LIMITATIONS: ${context.limitations.join(" ")}`,
  ].join("\n");
}
