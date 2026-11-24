import { Node, type Project } from "ts-morph";
import {
  addNode,
  evidence,
  type GraphParts,
  type HttpRoute,
} from "./framework-graph";
import { symbolId } from "./symbols-and-calls";
const methods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export function addNextRoutes(
  project: Project,
  paths: Set<string>,
  graph: GraphParts,
): { routes: HttpRoute[]; unresolved: number } {
  const routes: HttpRoute[] = [];
  let unresolved = 0;
  for (const filePath of paths) {
    const match =
      /(?:^|\/)app\/api\/(.+)\/route\.[cm]?[jt]s$/i.exec(filePath) ??
      /(?:^|\/)app\/api\/(route\.[cm]?[jt]s)$/i.exec(filePath);
    if (!match) continue;
    const suffix = match[1].startsWith("route.") ? "" : match[1];
    if (
      suffix &&
      suffix.split("/").some((part) => !part || /[\[\]()]/.test(part))
    ) {
      unresolved++;
      continue;
    }
    const pathname = `/api${suffix ? `/${suffix}` : ""}`;
    const source = project.getSourceFileOrThrow(`/workspace/${filePath}`);
    const functions = source
      .getFunctions()
      .filter(
        (node) =>
          node.isExported() && node.getName() && methods.has(node.getName()!),
      );
    const variables = source
      .getVariableStatements()
      .filter((node) => node.isExported())
      .flatMap((statement) =>
        statement
          .getDeclarations()
          .filter(
            (node) =>
              methods.has(node.getName()) &&
              Boolean(
                node.getInitializer() &&
                (Node.isArrowFunction(node.getInitializer()!) ||
                  Node.isFunctionExpression(node.getInitializer()!)),
              ),
          ),
      );
    for (const declaration of [...functions, ...variables]) {
      const method = declaration.getName()!;
      const name = declaration.getNameNode();
      if (!name) continue;
      const nodeId = `${filePath}#next-route:${declaration.getStart()}:${method}`,
        evidenceId = evidence(name, graph);
      addNode(declaration, nodeId, `${method} ${pathname}`, "route", graph);
      graph.edges.push({
        id: `${nodeId}:contains`,
        source: filePath,
        target: nodeId,
        kind: "contains",
        confidence: "framework",
        evidenceId,
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
      routes.push({ nodeId, path: pathname, method, evidenceId });
    }
  }
  return { routes, unresolved };
}
