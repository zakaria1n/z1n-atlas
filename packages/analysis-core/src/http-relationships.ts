import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type CallExpression,
  type VariableDeclaration,
} from "ts-morph";
import {
  addNode,
  evidence,
  relative,
  type HttpRoute as Route,
  type SymbolContext as Context,
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
  const seen = new Set<string>();
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 10; depth++) {
    const declaration: VariableDeclaration | undefined = unalias(
      current.getSymbol(),
    )
      ?.getDeclarations()
      .find(Node.isVariableDeclaration);
    if (!declaration) return null;
    const id = symbolId(declaration);
    if (seen.has(id)) return null;
    seen.add(id);
    const initializer: Node | undefined = declaration.getInitializer();
    if (
      initializer &&
      Node.isIdentifier(initializer) &&
      declaration.getVariableStatement()?.getDeclarationKind() ===
        VariableDeclarationKind.Const
    ) {
      current = initializer;
      continue;
    }
    return id;
  }
  return null;
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
export function addHttpRelationships(context: Context): number {
  const { graph } = context;
  const owners = new Map<string, "app" | "router">();
  const calls: CallExpression[] = [];
  let unresolved = 0;
  for (const { calls: fileCalls, callVariables } of context.sources) {
    for (const variable of callVariables) {
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
    for (const call of fileCalls) calls.push(call);
  }
  const mounts = new Map<
    string,
    { prefix: string; parent: string; call: CallExpression }[]
  >();
  for (const call of calls) {
    const pc = propertyCall(call),
      args = call.getArguments();
    if (
      !pc ||
      pc.method !== "use" ||
      !owners.has(ownerDeclaration(pc.owner) ?? "")
    )
      continue;
    const parent = ownerDeclaration(pc.owner)!,
      prefix = literal(args[0]),
      target = args[1] && ownerDeclaration(args[1]);
    if (
      !prefix ||
      !validPath(prefix) ||
      !target ||
      owners.get(target) !== "router"
    )
      continue;
    const list = mounts.get(target) ?? [];
    if (!list.some((item) => item.prefix === prefix && item.parent === parent))
      list.push({ prefix, parent, call });
    mounts.set(target, list);
  }
  function prefixesFor(
    owner: string,
    seen = new Set<string>(),
    budget = { remaining: 1000 },
  ): { prefix: string; calls: CallExpression[] }[] {
    if (--budget.remaining < 0) {
      if (budget.remaining === -1) unresolved++;
      return [];
    }
    if (seen.has(owner) || seen.size >= 8) {
      unresolved++;
      return [];
    }
    if (owners.get(owner) === "app") return [{ prefix: "", calls: [] }];
    const nextSeen = new Set(seen);
    nextSeen.add(owner);
    const results: { prefix: string; calls: CallExpression[] }[] = [];
    for (const mount of mounts.get(owner) ?? [])
      for (const parent of prefixesFor(mount.parent, nextSeen, budget)) {
        const prefix = joinPath(parent.prefix, mount.prefix);
        if (!results.some((item) => item.prefix === prefix))
          results.push({ prefix, calls: [...parent.calls, mount.call] });
        if (results.length >= 50) {
          unresolved++;
          return results;
        }
      }
    return results;
  }
  const nextRoutes = addNextRoutes(context);
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
    const prefixes = prefixesFor(owner);
    if (!prefixes.length) {
      unresolved++;
      continue;
    }
    for (const mount of prefixes) {
      const route = joinPath(mount.prefix, routePath),
        filePath = relative(call),
        nodeId = `${filePath}#route:${call.getStart()}:${encodeURIComponent(route)}`,
        evidenceId = evidence(call, graph),
        mountEvidenceIds = mount.calls.map((item) => evidence(item, graph));
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
        supportingEvidenceIds: mountEvidenceIds.length
          ? mountEvidenceIds
          : undefined,
      });
      routes.push({
        nodeId,
        path: route,
        method: pc.method.toUpperCase(),
        evidenceId,
        supportingEvidenceIds: mountEvidenceIds.length
          ? mountEvidenceIds
          : undefined,
      });
      for (const handler of args.slice(1)) {
        const target = resolveTarget(handler, context);
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
          supportingEvidenceIds: mountEvidenceIds.length
            ? mountEvidenceIds
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
      source: ownerId(call, context),
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
        ...(route.supportingEvidenceIds ?? []),
      ],
    });
  }
  return unresolved;
}
