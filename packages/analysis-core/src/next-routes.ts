import {
  ts,
  type FunctionDeclaration,
  type VariableDeclaration,
} from "ts-morph";
import {
  addNode,
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

export function addNextRoutes(context: SymbolContext): {
  routes: HttpRoute[];
  unresolved: number;
} {
  const { graph } = context;
  const routes: HttpRoute[] = [];
  let unresolved = 0;
  for (const { path, source, declarations } of context.sources) {
    const match =
      /(?:^|\/)app\/api\/(.+)\/route\.[cm]?[jt]s$/i.exec(path) ??
      /(?:^|\/)app\/api\/(route\.[cm]?[jt]s)$/i.exec(path);
    if (!match) continue;
    const manifest = context.manifests.next(path);
    if (!manifest) {
      unresolved++;
      continue;
    }
    const suffix = match[1].startsWith("route.") ? "" : match[1];
    if (
      suffix &&
      suffix.split("/").some((part) => !part || /[\[\]()]/.test(part))
    ) {
      unresolved++;
      continue;
    }
    const pathname = `/api${suffix ? `/${suffix}` : ""}`;
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
      const manifestEvidenceId = addManifestEvidence(manifest, graph);
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
      if (graph.nodes.some((node) => node.id === target))
        graph.edges.push({
          id: `${nodeId}:handles:${target}`,
          source: nodeId,
          target,
          kind: "handles",
          confidence: "framework",
          evidenceId,
        });
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
