import { Node, SyntaxKind, ts, type Symbol as MorphSymbol } from "ts-morph";
import {
  relative,
  type AnalysisContext,
  type SymbolContext,
} from "./framework-graph";
import type { SymbolNames } from "./source-nodes";

export type SymbolIndex = {
  /** Tracked declarations keyed by symbol node id. */
  declarations: Map<string, Node>;
  /** Ids of all symbol nodes. */
  ids: Set<string>;
  /** Ids of function and method nodes, which own calls and references written inside them. */
  owners: Set<string>;
};

function nameNode(node: Node): Node | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isPropertyDeclaration(node)
  )
    return node.getNameNode();
  return undefined;
}
function kind(node: Node): "function" | "method" | "class" {
  if (Node.isClassDeclaration(node)) return "class";
  if (Node.isMethodDeclaration(node) || Node.isPropertyDeclaration(node))
    return "method";
  return "function";
}
export function symbolId(node: Node): string {
  return `${relative(node)}#${node.getStart()}`;
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

export function addSymbolsAndCalls(context: AnalysisContext): {
  symbols: SymbolIndex;
  unresolvedCalls: number;
} {
  const { graph, names } = context;
  const declarations = new Map<string, Node>();
  for (const { path, declarations: tracked } of context.sources)
    for (const declaration of tracked) {
      const name = nameNode(declaration);
      if (!name) continue;
      const id = symbolId(declaration);
      declarations.set(id, declaration);
      graph.nodes.push({
        id,
        path,
        exports: [],
        kind: kind(declaration),
        name: name.getText(),
        startLine: declaration.getStartLineNumber(),
        endLine: declaration.getEndLineNumber(),
      });
      const evidenceId = `${path}:${name.getStart()}:contains:${id}`;
      graph.evidence.push({
        id: evidenceId,
        filePath: path,
        startLine: name.getStartLineNumber(),
        endLine: name.getEndLineNumber(),
        snippet: name.getText(),
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
  const symbols: SymbolIndex = {
    declarations,
    ids: new Set(declarations.keys()),
    owners: new Set(
      [...declarations]
        .filter(([, node]) => kind(node) !== "class")
        .map(([id]) => id),
    ),
  };
  let unresolvedCalls = 0;
  for (const { path, source, identifiers, calls } of context.sources) {
    for (const identifier of identifiers) {
      if (
        identifier.getFirstAncestor(
          (node) =>
            Node.isImportDeclaration(node) || Node.isExportDeclaration(node),
        )
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
      const parent = identifier.getParent();
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
  return { symbols, unresolvedCalls };
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
