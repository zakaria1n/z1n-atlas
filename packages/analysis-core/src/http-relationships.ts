import { Node, SyntaxKind, type CallExpression, type Project } from "ts-morph";
import {
  addNode,
  evidence,
  relative,
  type GraphParts as Parts,
  type HttpRoute as Route,
} from "./framework-graph";
import { addNextRoutes } from "./next-routes";
import { ownerId, resolveTarget, symbolId, unalias } from "./symbols-and-calls";

function literal(node: Node | undefined): string | null {
  return node && Node.isStringLiteral(node) ? node.getLiteralValue() : null;
}
function importedFromExpress(node: Node, name: "default" | "Router"): boolean {
  if (!Node.isIdentifier(node)) return false;
  const declarations = node.getSymbol()?.getDeclarations() ?? [];
  return declarations.some((declaration) => {
    const imp = declaration.getFirstAncestorByKind(
      SyntaxKind.ImportDeclaration,
    );
    if (!imp || imp.getModuleSpecifierValue() !== "express") return false;
    return name === "default"
      ? imp.getDefaultImport()?.getText() === node.getText()
      : imp
          .getNamedImports()
          .some(
            (item) =>
              item.getName() === "Router" &&
              (item.getAliasNode()?.getText() ?? item.getName()) ===
                node.getText(),
          );
  });
}
function ownerDeclaration(node: Node): string | null {
  const declaration = unalias(node.getSymbol())
    ?.getDeclarations()
    .find(Node.isVariableDeclaration);
  return declaration ? symbolId(declaration) : null;
}
function validPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[?#:*(){}]/.test(value)
  );
}
function propertyCall(
  call: CallExpression,
): { owner: Node; method: string } | null {
  const expression = call.getExpression();
  return Node.isPropertyAccessExpression(expression)
    ? {
        owner: expression.getExpression(),
        method: expression.getName().toLowerCase(),
      }
    : null;
}
function joinPath(prefix: string, route: string): string {
  return `${prefix.replace(/\/$/, "")}/${route.replace(/^\//, "")}` || "/";
}
export function addHttpRelationships(
  project: Project,
  paths: Set<string>,
  graph: Parts,
): number {
  const owners = new Map<string, "app" | "router">();
  const calls: CallExpression[] = [];
  let unresolved = 0;
  for (const filePath of paths) {
    const source = project.getSourceFileOrThrow(`/workspace/${filePath}`);
    for (const variable of source.getDescendantsOfKind(
      SyntaxKind.VariableDeclaration,
    )) {
      const initializer = variable.getInitializer();
      if (!initializer || !Node.isCallExpression(initializer)) continue;
      const expr = initializer.getExpression();
      if (importedFromExpress(expr, "default"))
        owners.set(symbolId(variable), "app");
      else if (
        importedFromExpress(expr, "Router") ||
        (Node.isPropertyAccessExpression(expr) &&
          expr.getName() === "Router" &&
          importedFromExpress(expr.getExpression(), "default"))
      )
        owners.set(symbolId(variable), "router");
    }
    calls.push(...source.getDescendantsOfKind(SyntaxKind.CallExpression));
  }
  const mounts = new Map<string, { prefix: string; call: CallExpression }[]>();
  for (const call of calls) {
    const pc = propertyCall(call),
      args = call.getArguments();
    if (
      !pc ||
      pc.method !== "use" ||
      owners.get(ownerDeclaration(pc.owner) ?? "") !== "app"
    )
      continue;
    const prefix = literal(args[0]),
      target = args[1] && ownerDeclaration(args[1]);
    if (
      !prefix ||
      !validPath(prefix) ||
      !target ||
      owners.get(target) !== "router"
    )
      continue;
    const list = mounts.get(target) ?? [];
    if (!list.some((item) => item.prefix === prefix))
      list.push({ prefix, call });
    mounts.set(target, list);
  }
  const nextRoutes = addNextRoutes(project, paths, graph);
  const routes: Route[] = nextRoutes.routes;
  unresolved += nextRoutes.unresolved;
  for (const call of calls) {
    const pc = propertyCall(call);
    if (!pc || !["get", "post", "put", "patch", "delete"].includes(pc.method))
      continue;
    const owner = ownerDeclaration(pc.owner),
      ownerType = owner && owners.get(owner);
    if (!owner || !ownerType) continue;
    const args = call.getArguments(),
      routePath = literal(args[0]);
    if (args.length < 2 || !routePath || !validPath(routePath)) {
      unresolved++;
      continue;
    }
    const prefixes =
      ownerType === "app"
        ? [{ prefix: "", call: undefined }]
        : (mounts.get(owner) ?? []);
    if (!prefixes.length) {
      unresolved++;
      continue;
    }
    for (const mount of prefixes) {
      const route = joinPath(mount.prefix, routePath),
        filePath = relative(call),
        nodeId = `${filePath}#route:${call.getStart()}:${encodeURIComponent(route)}`,
        evidenceId = evidence(call, graph),
        mountEvidenceId = mount.call ? evidence(mount.call, graph) : undefined;
      addNode(
        call,
        nodeId,
        `${pc.method.toUpperCase()} ${route}`,
        "route",
        graph,
      );
      const containerId = `${nodeId}:contains`;
      graph.edges.push({
        id: containerId,
        source: filePath,
        target: nodeId,
        kind: "contains",
        confidence: "framework",
        evidenceId,
        supportingEvidenceIds: mountEvidenceId ? [mountEvidenceId] : undefined,
      });
      routes.push({
        nodeId,
        path: route,
        method: pc.method.toUpperCase(),
        evidenceId,
        mountEvidenceId: mountEvidenceId,
      });
      for (const handler of args.slice(1)) {
        const target = resolveTarget(handler, graph);
        if (!target) {
          unresolved++;
          continue;
        }
        graph.edges.push({
          id: `${nodeId}:handles:${handler.getStart()}:${target}`,
          source: nodeId,
          target,
          kind: "handles",
          confidence: "framework",
          evidenceId,
          supportingEvidenceIds: mountEvidenceId
            ? [mountEvidenceId]
            : undefined,
        });
      }
    }
  }
  for (const call of calls) {
    const expr = call.getExpression();
    if (!Node.isIdentifier(expr) || expr.getText() !== "fetch") continue;
    if (
      (expr.getSymbol()?.getDeclarations() ?? []).some(
        (declaration) =>
          relative(declaration).startsWith("src/") ||
          declaration.getSourceFile().getFilePath().startsWith("/workspace/"),
      )
    )
      continue;
    const args = call.getArguments(),
      url = literal(args[0]);
    if (!url || !validPath(url)) {
      unresolved++;
      continue;
    }
    let method = "GET";
    if (args[1]) {
      if (
        !Node.isObjectLiteralExpression(args[1]) ||
        args[1].getProperties().some(Node.isSpreadAssignment)
      ) {
        unresolved++;
        continue;
      }
      const field = args[1].getProperty("method");
      if (field) {
        if (!Node.isPropertyAssignment(field)) {
          unresolved++;
          continue;
        }
        const m = literal(field.getInitializer());
        if (!m) {
          unresolved++;
          continue;
        }
        method = m.toUpperCase();
      }
    }
    const filePath = relative(call),
      id = `${filePath}#http:${call.getStart()}`,
      evidenceId = evidence(call, graph);
    addNode(call, id, `${method} ${url}`, "http-call", graph);
    graph.edges.push({
      id: `${id}:requests`,
      source: ownerId(call, graph),
      target: id,
      kind: "requests",
      confidence: "confirmed",
      evidenceId,
    });
    const matched = routes.filter(
      (route) => route.path === url && route.method === method,
    );
    if (matched.length !== 1) {
      unresolved++;
      continue;
    }
    const route = matched[0];
    graph.edges.push({
      id: `${id}:route:${route.nodeId}`,
      source: id,
      target: route.nodeId,
      kind: "http-route",
      confidence: "heuristic",
      evidenceId,
      supportingEvidenceIds: [
        route.evidenceId,
        ...(route.mountEvidenceId ? [route.mountEvidenceId] : []),
      ],
    });
  }
  return unresolved;
}
