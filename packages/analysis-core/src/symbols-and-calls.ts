import {
  Node,
  SyntaxKind,
  ts,
  VariableDeclarationKind,
  type CallExpression,
  type Symbol as MorphSymbol,
} from "ts-morph";
import type { GraphNode } from "@z1n/contracts";
import {
  relative,
  type AnalysisContext,
  type SymbolContext,
} from "./framework-graph";
import type { SymbolNames } from "./source-nodes";
import { nodeId } from "./workspace";

export type SymbolIndex = {
  /** Tracked declarations keyed by symbol node id. */
  declarations: Map<string, Node>;
  /** The symbol node created for each tracked declaration, keyed by the same id. */
  nodes: Map<string, GraphNode>;
  /** Ids of all symbol nodes. */
  ids: Set<string>;
  /** Ids of function and method nodes, which own calls and references written inside them. */
  owners: Set<string>;
};
export type SymbolResult = {
  symbols: SymbolIndex;
  unresolvedCalls: number;
  /** Target of each call that resolved to a tracked declaration, keyed by the call. */
  callTargets: Map<CallExpression, string>;
};

/** The name of a tracked declaration, or undefined for a nameless function. */
export function nameNode(node: Node | undefined): Node | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isPropertyAssignment(node)
  )
    return node.getNameNode();
  return undefined;
}
function kind(node: Node): "function" | "method" | "class" {
  if (Node.isClassDeclaration(node)) return "class";
  if (
    Node.isMethodDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isPropertyAssignment(node)
  )
    return "method";
  return "function";
}
export function symbolId(node: Node): string {
  return nodeId(relative(node), node.getStart());
}
export function unalias(
  symbol: MorphSymbol | undefined,
): MorphSymbol | undefined {
  const seen = new Set<MorphSymbol>();
  let current = symbol;
  while (
    current &&
    (current.getFlags() & ts.SymbolFlags.Alias) !== 0 &&
    !seen.has(current)
  ) {
    seen.add(current);
    current = current.getAliasedSymbol();
  }
  return current;
}

/**
 * A declaration resolved from an identifier carries either its declared name
 * or an import or export alias, and one resolved from a property access only
 * its declared member name. Names outside those sets cannot resolve, so the
 * type checker is not consulted for them.
 */
export function mayResolve(node: Node, names: SymbolNames): boolean {
  let expression: Node = node;
  while (
    Node.isParenthesizedExpression(expression) ||
    Node.isAsExpression(expression) ||
    Node.isNonNullExpression(expression) ||
    Node.isSatisfiesExpression(expression)
  )
    expression = expression.getExpression();
  const raw = expression.compilerNode;
  if (ts.isIdentifier(raw) || ts.isPrivateIdentifier(raw))
    return names.any.has(raw.text);
  if (ts.isPropertyAccessExpression(raw))
    return names.declared.has(raw.name.text);
  return true;
}

/**
 * The value of an expression that is a fixed string: a string literal, a
 * constant that holds one, or a concatenation of these. Anything that can
 * differ at runtime yields null.
 */
export function constantString(
  node: Node | undefined,
  depth = 4,
): string | null {
  if (!node || depth < 0) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return node.getLiteralValue();
  if (Node.isParenthesizedExpression(node))
    return constantString(node.getExpression(), depth - 1);
  if (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getKind() === SyntaxKind.PlusToken
  ) {
    const left = constantString(node.getLeft(), depth - 1);
    const right =
      left === null ? null : constantString(node.getRight(), depth - 1);
    return left !== null && right !== null ? left + right : null;
  }
  if (Node.isIdentifier(node)) {
    const declaration = unalias(node.getSymbol())
      ?.getDeclarations()
      .find(Node.isVariableDeclaration);
    if (
      !declaration ||
      declaration.getVariableStatement()?.getDeclarationKind() !==
        VariableDeclarationKind.Const
    )
      return null;
    return constantString(declaration.getInitializer(), depth - 1);
  }
  return null;
}

export function addSymbolsAndCalls(context: AnalysisContext): SymbolResult {
  const { graph, names } = context;
  const declarations = new Map<string, Node>();
  function addSymbol(
    path: string,
    node: Node,
    name: string,
    symbolKind: "function" | "method" | "class",
    proof: Node,
    snippet: string,
    proofEndLine: number,
  ) {
    const id = symbolId(node);
    declarations.set(id, node);
    graph.nodes.push({
      id,
      path,
      exports: [],
      kind: symbolKind,
      name,
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
    });
    const evidenceId = `${path}:${proof.getStart()}:contains:${id}`;
    graph.evidence.push({
      id: evidenceId,
      filePath: path,
      startLine: proof.getStartLineNumber(),
      endLine: proofEndLine,
      snippet,
    });
    graph.edges.push({
      id: evidenceId,
      source: path,
      target: id,
      kind: "contains",
      confidence: "confirmed",
      evidenceId,
    });
  }
  for (const { path, declarations: tracked, anonymous } of context.sources) {
    for (const declaration of tracked) {
      const name = nameNode(declaration);
      if (!name) continue;
      addSymbol(
        path,
        declaration,
        name.getText(),
        kind(declaration),
        name,
        name.getText(),
        name.getEndLineNumber(),
      );
    }
    // A nameless function has no name to point at, so its first line is the
    // evidence that the file contains it.
    for (const { node, name } of anonymous) {
      const startLine = node.getStartLineNumber();
      addSymbol(
        path,
        node,
        name,
        "function",
        node,
        node.getText().split(/\r\n|\r|\n/)[0],
        startLine,
      );
    }
  }
  const symbols: SymbolIndex = {
    declarations,
    nodes: new Map(
      graph.nodes.filter((node) => node.kind).map((node) => [node.id, node]),
    ),
    ids: new Set(declarations.keys()),
    owners: new Set(
      [...declarations]
        .filter(([, node]) => kind(node) !== "class")
        .map(([id]) => id),
    ),
  };
  const callTargets = new Map<CallExpression, string>();
  let unresolvedCalls = 0;
  for (const { path, source, identifiers, calls } of context.sources) {
    const reactFile = context.reactFiles.has(path);
    for (const identifier of identifiers) {
      if (
        identifier.getFirstAncestor(
          (node) =>
            Node.isImportDeclaration(node) || Node.isExportDeclaration(node),
        )
      )
        continue;
      const parent = identifier.getParent();
      // A rendered component is reported as a render, not as a reference.
      if (
        reactFile &&
        (Node.isJsxOpeningElement(parent) ||
          Node.isJsxSelfClosingElement(parent))
      )
        continue;
      const symbol = unalias(identifier.getSymbol());
      const declared = symbol?.getDeclarations() ?? [];
      const targets = [
        ...new Set(declared.map(symbolId).filter((id) => declarations.has(id))),
      ];
      if (
        targets.length !== 1 ||
        declared.some(
          (declaration) =>
            nameNode(declaration)?.getStart() === identifier.getStart() &&
            declaration.getSourceFile() === source,
        )
      )
        continue;
      if (
        Node.isCallExpression(parent) &&
        parent.getExpression() === identifier
      )
        continue;
      const grandparent = parent.getParent();
      if (
        Node.isPropertyAccessExpression(parent) &&
        Node.isCallExpression(grandparent) &&
        grandparent.getExpression() === parent
      )
        continue;
      let owner: Node | undefined = parent;
      let sourceId = path;
      while (owner && !Node.isSourceFile(owner)) {
        const id = symbolId(owner);
        if (declarations.has(id)) {
          sourceId = id;
          break;
        }
        owner = owner.getParent();
      }
      const target = targets[0];
      if (sourceId === target) continue;
      const id = `${path}:${identifier.getStart()}:references:${target}`;
      graph.evidence.push({
        id,
        filePath: path,
        startLine: identifier.getStartLineNumber(),
        endLine: identifier.getEndLineNumber(),
        snippet: identifier.getText(),
      });
      graph.edges.push({
        id,
        source: sourceId,
        target,
        kind: "references",
        confidence: "confirmed",
        evidenceId: id,
      });
    }
    for (const call of calls) {
      const expression = call.getExpression();
      if (expression.getKind() === SyntaxKind.ImportKeyword) continue;
      if (!mayResolve(expression, names)) {
        unresolvedCalls++;
        continue;
      }
      const symbol = unalias(expression.getSymbol());
      const targets = (symbol?.getDeclarations() ?? [])
        .map(symbolId)
        .filter((id) => declarations.has(id));
      const unique = [...new Set(targets)];
      if (unique.length !== 1) {
        unresolvedCalls++;
        continue;
      }
      let parent: Node | undefined = call.getParent();
      let sourceId = path;
      while (parent && !Node.isSourceFile(parent)) {
        const id = symbolId(parent);
        if (declarations.has(id)) {
          sourceId = id;
          break;
        }
        parent = parent.getParent();
      }
      const target = unique[0];
      callTargets.set(call, target);
      const id = `${path}:${call.getStart()}:calls:${target}`;
      graph.evidence.push({
        id,
        filePath: path,
        startLine: call.getStartLineNumber(),
        endLine: call.getEndLineNumber(),
        snippet: call.getText(),
      });
      graph.edges.push({
        id,
        source: sourceId,
        target,
        kind: "calls",
        confidence: "confirmed",
        evidenceId: id,
      });
    }
  }
  return { symbols, unresolvedCalls, callTargets };
}

export function resolveTarget(
  node: Node,
  context: SymbolContext,
): string | null {
  if (!mayResolve(node, context.names)) return null;
  const targets = [
    ...new Set(
      (unalias(node.getSymbol())?.getDeclarations() ?? [])
        .map(symbolId)
        .filter((id) => context.symbols.ids.has(id)),
    ),
  ];
  return targets.length === 1 ? targets[0] : null;
}
export function ownerId(node: Node, context: SymbolContext): string {
  let current: Node | undefined = node.getParent();
  while (current && !Node.isSourceFile(current)) {
    const id = symbolId(current);
    if (context.symbols.owners.has(id)) return id;
    current = current.getParent();
  }
  return relative(node);
}
