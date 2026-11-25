import {
  ts,
  type FunctionDeclaration,
  type VariableDeclaration,
} from "ts-morph";
import {
  addNode,
  addUnresolved,
  evidence,
  type HttpRoute,
  type SymbolContext,
} from "./framework-graph";
import { addManifestEvidence } from "./next-manifest";
import { symbolId } from "./symbols-and-calls";
import { hasExportModifier, localExportNames } from "./source-nodes";
const methods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

type ApiRoute =
  { router: "app"; suffix: string } | { router: "pages"; suffix: string };
/**
 * App Router directories expose one route per exported method, while a Pages
 * Router file handles every method with its default export.
 */
function apiRoute(path: string): ApiRoute | null {
  const app =
    /(?:^|\/)app\/api\/(.+)\/route\.[cm]?[jt]s$/i.exec(path) ??
    /(?:^|\/)app\/api\/(route\.[cm]?[jt]s)$/i.exec(path);
  if (app)
    return { router: "app", suffix: app[1].startsWith("route.") ? "" : app[1] };
  const pages = /(?:^|\/)pages\/api\/(.+)\.[jt]sx?$/i.exec(path);
  if (pages)
    return { router: "pages", suffix: pages[1] === "index" ? "" : pages[1] };
  return null;
}

export function addNextRoutes(context: SymbolContext): {
  routes: HttpRoute[];
  unresolved: number;
} {
  const { graph } = context;
  const routes: HttpRoute[] = [];
  let unresolved = 0;
  for (const { path, source, declarations } of context.sources) {
    const api = apiRoute(path);
    if (!api) continue;
    const manifest = context.manifests.next(path);
    if (!manifest) {
      unresolved++;
      continue;
    }
    if (
      api.suffix &&
      api.suffix.split("/").some((part) => !part || /[\[\]()]/.test(part))
    ) {
      unresolved++;
      continue;
    }
    const pathname = `/api${api.suffix ? `/${api.suffix}` : ""}`;
    const manifestEvidenceId = addManifestEvidence(manifest, graph);
    if (api.router === "pages") {
      const handler = source
        .getFunctions()
        .find((item) => item.isDefaultExport());
      const assignment = handler
        ? undefined
        : source.getExportAssignments().find((item) => !item.isExportEquals());
      const declaration = handler ?? assignment?.getExpression();
      const target =
        declaration && context.symbols.nodes.get(symbolId(declaration));
      if (!declaration || !target) {
        unresolved++;
        continue;
      }
      const routeName = `ANY ${pathname}`;
      if (target.name === "default export")
        target.name = `${routeName} handler`;
      const name = handler?.getNameNode();
      // A nameless default export already carries the evidence of its first line.
      const evidenceId = name
        ? evidence(name, graph)
        : `${path}:${declaration.getStart()}:contains:${target.id}`;
      const nodeId = `${path}#next-route:${declaration.getStart()}:ANY`;
      addNode(declaration, nodeId, routeName, "route", graph);
      graph.edges.push({
        id: `${nodeId}:contains`,
        source: path,
        target: nodeId,
        kind: "contains",
        confidence: "framework",
        evidenceId,
        supportingEvidenceIds: [manifestEvidenceId],
      });
      graph.edges.push({
        id: `${nodeId}:handles:${target.id}`,
        source: nodeId,
        target: target.id,
        kind: "handles",
        confidence: "framework",
        evidenceId,
      });
      routes.push({
        nodeId,
        path: pathname,
        method: "ANY",
        evidenceId,
        supportingEvidenceIds: [manifestEvidenceId],
      });
      continue;
    }
    const localExports = localExportNames(source);
    const handlers = declarations.filter(
      (node): node is FunctionDeclaration | VariableDeclaration => {
        const declaration = node.compilerNode;
        if (ts.isFunctionDeclaration(declaration))
          return (
            declaration.name !== undefined &&
            methods.has(declaration.name.text) &&
            (hasExportModifier(declaration, declaration) ||
              localExports.has(declaration.name.text))
          );
        return (
          ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          methods.has(declaration.name.text) &&
          hasExportModifier(declaration, declaration.parent.parent)
        );
      },
    );
    for (const declaration of handlers) {
      const method = declaration.getName();
      const name = declaration.getNameNode();
      if (!method || !name) continue;
      const nodeId = `${path}#next-route:${declaration.getStart()}:${method}`,
        evidenceId = evidence(name, graph);
      addNode(declaration, nodeId, `${method} ${pathname}`, "route", graph);
      graph.edges.push({
        id: `${nodeId}:contains`,
        source: path,
        target: nodeId,
        kind: "contains",
        confidence: "framework",
        evidenceId,
        supportingEvidenceIds: [manifestEvidenceId],
      });
      const target = symbolId(declaration);
      const handler = context.symbols.nodes.get(target);
      if (handler) {
        graph.edges.push({
          id: `${nodeId}:handles:${target}`,
          source: nodeId,
          target,
          kind: "handles",
          confidence: "framework",
          evidenceId,
        });
      } else {
        unresolved++;
        addUnresolved(
          declaration,
          context,
          "handler",
          `${method} ${pathname} is not an analyzed function.`,
        );
      }
      routes.push({
        nodeId,
        path: pathname,
        method,
        evidenceId,
        supportingEvidenceIds: [manifestEvidenceId],
      });
    }
  }
  return { routes, unresolved };
}
