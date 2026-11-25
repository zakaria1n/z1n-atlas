import {
  Node,
  SyntaxKind,
  ts,
  VariableDeclarationKind,
  type CallExpression,
  type ParameterDeclaration,
  type VariableDeclaration,
} from "ts-morph";
import {
  addNode,
  addUnresolved,
  evidence,
  relative,
  type HttpRoute as Route,
  type SymbolContext as Context,
} from "./framework-graph";
import type { HttpRequestFact, HttpRouteFact } from "./http-match";
import { addNextRoutes } from "./next-routes";
import {
  constantString,
  nameNode,
  ownerId,
  resolveTarget,
  symbolId,
  unalias,
} from "./symbols-and-calls";
import { httpVerbs } from "./source-nodes";

type Confidence = "confirmed" | "framework" | "heuristic";
type Request = {
  call: CallExpression;
  url: string;
  method: string;
  confidence: Confidence;
  supportingEvidenceIds?: string[];
};
/**
 * A function whose single `fetch` sends what the function itself receives:
 * the usual shape of an API client. Its requests are reported where it is
 * called with a literal address, because that is where the address is known.
 */
type Forwarder = {
  name: Node;
  fetchCall: CallExpression;
  urlIndex: number;
  method: { value: string } | { argumentIndex: number; defaultValue?: string };
};
const clientVerbs = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "request",
]);

/** Whether an identifier is imported from a module under its own name or as the default import. */
function importedFrom(
  node: Node,
  module: string,
  name: "default" | string,
): boolean {
  if (!Node.isIdentifier(node)) return false;
  const declarations = node.getSymbol()?.getDeclarations() ?? [];
  return declarations.some((declaration) => {
    const imp = declaration.getFirstAncestorByKind(
      SyntaxKind.ImportDeclaration,
    );
    if (!imp || imp.getModuleSpecifierValue() !== module) return false;
    return name === "default"
      ? imp.getDefaultImport()?.getText() === node.getText()
      : imp
          .getNamedImports()
          .some(
            (item) =>
              item.getName() === name &&
              (item.getAliasNode()?.getText() ?? item.getName()) ===
                node.getText(),
          );
  });
}
function isAxios(node: Node): boolean {
  return (
    importedFrom(node, "axios", "default") ||
    importedFrom(node, "axios", "axios")
  );
}
/**
 * Reads the HTTP method from request options. Returns undefined when the
 * options are not a plain object with a literal method.
 */
function methodFromOptions(options: Node | undefined): string | undefined {
  if (options === undefined) return "GET";
  if (
    !Node.isObjectLiteralExpression(options) ||
    options.getProperties().some(Node.isSpreadAssignment)
  )
    return undefined;
  const field = options.getProperty("method");
  if (!field) return "GET";
  if (!Node.isPropertyAssignment(field)) return undefined;
  const value = constantString(field.getInitializer());
  return value === null ? undefined : value.toUpperCase();
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
/** A request path whose interpolations have become {param} segments. */
function validParameterizedPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[?#*()]/.test(value) &&
    value
      .split("/")
      .every(
        (segment) =>
          segment === "" || /^[\w.\-]*(\{param\})?[\w.\-]*$/.test(segment),
      )
  );
}
/** The addressed resource of a request, without its query string. */
function stripQuery(value: string): string {
  const query = value.indexOf("?");
  const path = query === -1 ? value : value.slice(0, query);
  return path.length ? path : "/";
}
/**
 * Reads a request address as a literal or a parameterized pattern. Template
 * interpolations become {param}; constants that hold template literals are
 * folded, so a shared base address keeps its literal segments.
 */
function requestUrl(node: Node | undefined): string | null {
  const constant = constantString(node);
  if (constant !== null) return stripQuery(constant);
  const pattern = parameterPattern(node);
  return pattern !== null && validParameterizedPath(pattern)
    ? stripQuery(pattern)
    : null;
}
function parameterPattern(node: Node | undefined, depth = 6): string | null {
  if (!node || depth < 0) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return node.getLiteralText();
  if (Node.isTemplateExpression(node)) {
    let pattern = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      const value = parameterPattern(span.getExpression(), depth - 1);
      pattern += value ?? "{param}";
      pattern += span.getLiteral().getLiteralText();
    }
    return pattern;
  }
  if (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getText() === "+"
  ) {
    const left = parameterPattern(node.getLeft(), depth - 1);
    const right = parameterPattern(node.getRight(), depth - 1);
    return left !== null && right !== null ? left + right : null;
  }
  if (Node.isIdentifier(node)) {
    const declaration = unalias(node.getSymbol())
      ?.getDeclarations()
      .find(Node.isVariableDeclaration);
    if (
      declaration &&
      declaration.getVariableStatement()?.getDeclarationKind() ===
        VariableDeclarationKind.Const
    )
      return parameterPattern(declaration.getInitializer(), depth - 1);
  }
  return null;
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
/**
 * The parameter of `owner` that an argument of its `fetch` stands for. The
 * parameter must belong to a function written inside the owner: a function
 * assigned to a member is owned by that member, and a value captured from an
 * outer scope is not an argument of the owner.
 */
function forwardedParameter(
  argument: Node | undefined,
  owner: Node | undefined,
): ParameterDeclaration | null {
  if (!argument || !owner || !Node.isIdentifier(argument)) return null;
  const parameter = unalias(argument.getSymbol())
    ?.getDeclarations()
    .find(Node.isParameterDeclaration);
  if (!parameter) return null;
  const signature = enclosingSignature(parameter);
  return owner.getStart() <= signature.getStart() &&
    signature.getEnd() <= owner.getEnd()
    ? parameter
    : null;
}
/**
 * The wrapper parameter whose value is passed as a request method. The fetch
 * options may forward the whole options parameter, or pick one binding out of
 * a destructured parameter — `fetch(path, { method })` inside a function
 * whose signature reads `{ method = "GET" }` — and that default then applies
 * to callers that state no method of their own.
 */
function forwardedMethod(
  owner: Node | undefined,
  options: Node | undefined,
): { index: number; defaultValue?: string } | null {
  if (!owner || !options || !Node.isObjectLiteralExpression(options))
    return null;
  const property = options.getProperty("method");
  let wanted: string | null = null;
  if (property && Node.isShorthandPropertyAssignment(property))
    wanted = property.getNameNode().getText();
  else if (property && Node.isPropertyAssignment(property)) {
    const initializer = property.getInitializer();
    if (Node.isIdentifier(initializer)) wanted = initializer.getText();
  }
  if (!wanted) return null;
  const parameters = functionParameters(owner);
  for (let index = 0; index < parameters.length; index++) {
    const nameNode = parameters[index].getNameNode();
    if (Node.isIdentifier(nameNode)) {
      if (nameNode.getText() === wanted) return { index };
    } else if (Node.isObjectBindingPattern(nameNode))
      for (const element of nameNode.getElements()) {
        const local = element.getPropertyNameNode() ?? element.getNameNode();
        if (local.getText() !== wanted) continue;
        const initializer = element.getInitializer();
        return {
          index,
          defaultValue:
            initializer && Node.isStringLiteral(initializer)
              ? initializer.getLiteralText().toUpperCase()
              : undefined,
        };
      }
  }
  return null;
}
/** The parameters of a tracked function declaration. */
function functionParameters(owner: Node) {
  return Node.isFunctionDeclaration(owner) ||
    Node.isArrowFunction(owner) ||
    Node.isFunctionExpression(owner) ||
    Node.isMethodDeclaration(owner)
    ? owner.getParameters()
    : [];
}
/**
 * The position of a parameter in its function. The parameter list of the
 * function is read instead of the parameter's ancestors, whose shape differs
 * between compiler versions.
 */
function parameterIndex(parameter: ParameterDeclaration): number {
  return enclosingSignature(parameter).parameters.indexOf(
    parameter.compilerNode as ts.ParameterDeclaration,
  );
}
function signatureOf(node: ts.Node): ts.SignatureDeclaration | undefined {
  return ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
    ? node
    : undefined;
}
/** The function a parameter belongs to. Its parent is the function or the parameter list inside it. */
function enclosingSignature(
  parameter: ParameterDeclaration,
): ts.SignatureDeclaration {
  const parent = parameter.compilerNode.parent;
  const signature = signatureOf(parent) ?? signatureOf(parent.parent);
  if (!signature)
    throw new Error("A parameter is declared outside a function.");
  return signature;
}
/**
 * Resolves a route handler. A handler written inline is a node already, named
 * after the route as written at its call; the complete route is known only
 * here, so the node takes that name.
 */
function handlerTarget(
  handler: Node,
  context: Context,
  routeName: string,
): string | null {
  const target =
    resolveTarget(handler, context) ??
    context.symbols.nodes.get(symbolId(handler))?.id;
  if (!target) return null;
  const node = context.symbols.nodes.get(target);
  if (node?.name?.endsWith(" callback")) node.name = `${routeName} handler`;
  return target;
}
function isLocalFetch(expression: Node): boolean {
  return (expression.getSymbol()?.getDeclarations() ?? []).some(
    (declaration) =>
      relative(declaration).startsWith("src/") ||
      declaration.getSourceFile().getFilePath().startsWith("/workspace/"),
  );
}
function axiosProof(node: Node): Node | undefined {
  const instance = unalias(node.getSymbol())
    ?.getDeclarations()
    .find(Node.isVariableDeclaration);
  if (instance) return instance;
  const imp = node
    .getSymbol()
    ?.getDeclarations()?.[0]
    ?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  return imp && imp.getModuleSpecifierValue() === "axios" ? imp : undefined;
}

export function addHttpRelationships(context: Context): {
  unresolved: number;
  routes: HttpRouteFact[];
  requests: HttpRequestFact[];
} {
  const { graph } = context;
  const owners = new Map<string, "app" | "router">();
  const calls: CallExpression[] = [];
  let unresolved = 0;
  for (const { calls: fileCalls, callVariables } of context.sources) {
    for (const variable of callVariables) {
      const initializer = variable.getInitializer();
      if (!initializer || !Node.isCallExpression(initializer)) continue;
      const expr = initializer.getExpression();
      if (
        importedFrom(expr, "express", "default") ||
        importedFrom(expr, "fastify", "default")
      )
        owners.set(symbolId(variable), "app");
      else if (
        importedFrom(expr, "express", "Router") ||
        (Node.isPropertyAccessExpression(expr) &&
          expr.getName() === "Router" &&
          importedFrom(expr.getExpression(), "express", "default"))
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
      prefix = constantString(args[0]),
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
    if (!pc || !httpVerbs.has(pc.method)) continue;
    const args = call.getArguments();
    let routePath = constantString(args[0]);
    let router = pc.owner;
    let chain: CallExpression | undefined;
    // `app.route('/x').get(handler)` carries its path on the outer call.
    if (routePath === null && Node.isCallExpression(pc.owner)) {
      const outer = propertyCall(pc.owner);
      const [outerPath] = pc.owner.getArguments();
      if (
        outer?.method === "route" &&
        constantString(outerPath)?.startsWith("/")
      ) {
        routePath = constantString(outerPath);
        chain = pc.owner;
        router = outer.owner;
      }
    }
    const owner = ownerDeclaration(router);
    if (!owner || !owners.get(owner)) continue;
    const handlers = chain ? args : args.slice(1);
    if (!routePath || !validPath(routePath)) {
      unresolved++;
      addUnresolved(
        args[0] ?? call,
        context,
        "route",
        `The path of this ${pc.method} route is not a literal value.`,
      );
      continue;
    }
    if (!handlers.length) {
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
        routeName = `${pc.method.toUpperCase()} ${route}`,
        nodeId = `${filePath}#route:${call.getStart()}:${encodeURIComponent(route)}`,
        evidenceId = evidence(call, graph),
        mountEvidenceIds = [
          ...mount.calls.map((item) => evidence(item, graph)),
          ...(chain ? [evidence(chain, graph)] : []),
        ];
      addNode(call, nodeId, routeName, "route", graph);
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
      for (const handler of handlers) {
        const target = handlerTarget(handler, context, routeName);
        if (!target) {
          unresolved++;
          addUnresolved(
            handler,
            context,
            "handler",
            `The handler of ${routeName} could not be resolved to an analyzed function.`,
          );
          continue;
        }
        graph.edges.push({
          id: `${nodeId}:handles:${handler.getStart()}:${target}`,
          source: nodeId,
          target,
          kind: "handles",
          confidence: "framework",
          supportingEvidenceIds: mountEvidenceIds.length
            ? mountEvidenceIds
            : undefined,
          evidenceId,
        });
      }
    }
  }
  const requests: Request[] = [];
  const fetches: { call: CallExpression; args: Node[]; owner: string }[] = [];
  const fetchesInOwner = new Map<string, number>();
  for (const call of calls) {
    const expression = call.getExpression();
    if (
      !Node.isIdentifier(expression) ||
      expression.getText() !== "fetch" ||
      isLocalFetch(expression)
    )
      continue;
    const owner = ownerId(call, context);
    fetches.push({ call, args: call.getArguments(), owner });
    if (context.symbols.owners.has(owner))
      fetchesInOwner.set(owner, (fetchesInOwner.get(owner) ?? 0) + 1);
  }
  const forwarders = new Map<string, Forwarder>();
  const forwarded = new Set<CallExpression>();
  for (const { call, args, owner } of fetches) {
    if (
      constantString(args[0]) !== null ||
      fetchesInOwner.get(owner) !== 1 ||
      !context.symbols.owners.has(owner)
    )
      continue;
    const ownerNode = context.symbols.declarations.get(owner);
    const name = nameNode(ownerNode);
    const url = forwardedParameter(args[0], ownerNode);
    if (!name || !url) continue;
    // The method is fixed when the wrapper states it, comes from the options
    // each caller passes, or falls back to a destructured default.
    const stated = methodFromOptions(args[1]);
    let method: Forwarder["method"];
    if (stated !== undefined) method = { value: stated };
    else {
      const options = forwardedParameter(args[1], ownerNode);
      if (options !== null) method = { argumentIndex: parameterIndex(options) };
      else {
        const binding = forwardedMethod(ownerNode, args[1]);
        if (binding)
          method = {
            argumentIndex: binding.index,
            defaultValue: binding.defaultValue,
          };
        else continue;
      }
    }
    forwarders.set(owner, {
      name,
      fetchCall: call,
      urlIndex: parameterIndex(url),
      method,
    });
    forwarded.add(call);
  }
  for (const call of calls) {
    const target = context.callTargets.get(call);
    const forwarder = target ? forwarders.get(target) : undefined;
    if (!forwarder) continue;
    const args = call.getArguments();
    const name = forwarder.name.getText();
    const url = requestUrl(args[forwarder.urlIndex]);
    if (!url || !validParameterizedPath(url)) {
      unresolved++;
      addUnresolved(
        args[forwarder.urlIndex] ?? call,
        context,
        "request",
        `The address passed to ${name}() is not a literal path.`,
      );
      continue;
    }
    const forwardedOptions =
      "argumentIndex" in forwarder.method
        ? args[forwarder.method.argumentIndex]
        : undefined;
    const method =
      "value" in forwarder.method
        ? forwarder.method.value
        : (methodFromOptions(forwardedOptions) ??
          (
            forwarder.method as {
              argumentIndex: number;
              defaultValue?: string;
            }
          ).defaultValue);
    if (!method) {
      unresolved++;
      addUnresolved(
        forwardedOptions ?? call,
        context,
        "request",
        `The HTTP method passed to ${name}() is not a literal value.`,
      );
      continue;
    }
    requests.push({
      call,
      url,
      method,
      confidence: "heuristic",
      supportingEvidenceIds: [
        evidence(forwarder.fetchCall, graph),
        evidence(forwarder.name, graph),
      ],
    });
  }
  for (const { call, args } of fetches) {
    // A forwarded address is reported at the call sites of its wrapper.
    if (forwarded.has(call)) continue;
    const url = requestUrl(args[0]);
    if (!url || !validParameterizedPath(url)) {
      unresolved++;
      addUnresolved(
        args[0] ?? call,
        context,
        "request",
        "The address of this request is not a literal path.",
      );
      continue;
    }
    const method = methodFromOptions(args[1]);
    if (!method) {
      unresolved++;
      addUnresolved(
        args[1],
        context,
        "request",
        "The HTTP method of this request is not a literal value.",
      );
      continue;
    }
    requests.push({ call, url, method, confidence: "confirmed" });
  }
  const axiosInstances = new Map<string, string>();
  for (const { callVariables } of context.sources)
    for (const variable of callVariables) {
      const initializer = variable.getInitializer();
      if (!initializer || !Node.isCallExpression(initializer)) continue;
      const expr = initializer.getExpression();
      if (
        !Node.isPropertyAccessExpression(expr) ||
        expr.getName() !== "create" ||
        !Node.isIdentifier(expr.getExpression()) ||
        !isAxios(expr.getExpression())
      )
        continue;
      const [config] = initializer.getArguments();
      let base = "";
      if (config !== undefined) {
        if (!Node.isObjectLiteralExpression(config)) continue;
        const field = config.getProperty("baseURL");
        if (field) {
          if (!Node.isPropertyAssignment(field)) continue;
          const value = constantString(field.getInitializer());
          if (value === null || !validPath(value)) continue;
          base = value;
        }
      }
      axiosInstances.set(symbolId(variable), base);
    }
  for (const call of calls) {
    const pc = propertyCall(call);
    if (!pc || !clientVerbs.has(pc.method)) continue;
    const direct = Node.isIdentifier(pc.owner) && isAxios(pc.owner);
    const base = direct
      ? ""
      : axiosInstances.get(ownerDeclaration(pc.owner) ?? "");
    if (base === undefined) continue;
    const args = call.getArguments();
    let url: string | null = null;
    let method: string | undefined;
    if (pc.method === "request") {
      const config = args[0];
      if (config && Node.isObjectLiteralExpression(config)) {
        const field = config.getProperty("url");
        url =
          field && Node.isPropertyAssignment(field)
            ? constantString(field.getInitializer())
            : null;
        method = methodFromOptions(config);
      }
    } else {
      url = requestUrl(args[0]);
      method = pc.method.toUpperCase();
    }
    if (!url || !validParameterizedPath(url)) {
      unresolved++;
      addUnresolved(
        args[0] ?? call,
        context,
        "request",
        "The address of this axios request is not a literal path.",
      );
      continue;
    }
    const proof = axiosProof(pc.owner);
    if (!method || !proof) {
      unresolved++;
      addUnresolved(
        args[0] ?? call,
        context,
        "request",
        "This axios request has no literal HTTP method.",
      );
      continue;
    }
    requests.push({
      call,
      url: base ? joinPath(base, url) : url,
      method,
      confidence: "framework",
      supportingEvidenceIds: [evidence(proof, graph)],
    });
  }
  const facts: HttpRequestFact[] = [];
  for (const {
    call,
    url,
    method,
    confidence,
    supportingEvidenceIds,
  } of requests) {
    const filePath = relative(call),
      id = `${filePath}#http:${call.getStart()}`,
      evidenceId = evidence(call, graph);
    addNode(call, id, `${method} ${url}`, "http-call", graph);
    graph.edges.push({
      id: `${id}:requests`,
      source: ownerId(call, context),
      target: id,
      kind: "requests",
      confidence,
      evidenceId,
      supportingEvidenceIds,
    });
    facts.push({
      nodeId: id,
      url,
      method,
      evidenceId,
      location: {
        filePath,
        start: call.getStart(),
        startLine: call.getStartLineNumber(),
        endLine: call.getEndLineNumber(),
        snippet: call.getText(),
      },
    });
  }
  return {
    unresolved,
    routes: routes.map(
      ({ nodeId, path, method, evidenceId, supportingEvidenceIds }) => ({
        nodeId,
        path,
        method,
        evidenceId,
        supportingEvidenceIds,
      }),
    ),
    requests: facts,
  };
}
