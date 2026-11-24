import {
  Node,
  SyntaxKind,
  ts,
  type Project,
  type SourceFile,
  type Symbol as MorphSymbol,
} from "ts-morph";
import type { GraphEdge, GraphEvidence, GraphNode } from "@z1n/contracts";

type GraphParts = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: GraphEvidence[];
};
function relative(source: SourceFile): string {
  return source.getFilePath().replace(/^\/workspace\//, "");
}
export function symbolId(node: Node): string {
  return `${relative(node.getSourceFile())}#${node.getStart()}`;
}
function namedDeclarations(source: SourceFile): Node[] {
  const functions = source
    .getDescendantsOfKind(SyntaxKind.FunctionDeclaration)
    .filter((node) => Boolean(node.getNameNode() && node.getBody()));
  const methods = source
    .getDescendantsOfKind(SyntaxKind.MethodDeclaration)
    .filter((node) => Boolean(node.getNameNode() && node.getBody()));
  const classes = source
    .getDescendantsOfKind(SyntaxKind.ClassDeclaration)
    .filter((node) => Boolean(node.getNameNode()));
  const variables = source
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter((node) => {
      const initializer = node.getInitializer();
      return Boolean(
        initializer &&
        (Node.isArrowFunction(initializer) ||
          Node.isFunctionExpression(initializer)) &&
        Node.isIdentifier(node.getNameNode()),
      );
    });
  return [...functions, ...methods, ...classes, ...variables];
}
function nameNode(node: Node): Node | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isVariableDeclaration(node)
  )
    return node.getNameNode();
  return undefined;
}
function kind(node: Node): "function" | "method" | "class" {
  if (Node.isClassDeclaration(node)) return "class";
  if (Node.isMethodDeclaration(node)) return "method";
  return "function";
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
export function addSymbolsAndCalls(
  project: Project,
  paths: Set<string>,
  graph: GraphParts,
): number {
  let unresolvedCalls = 0;
  const declarations = new Map<string, Node>();
  for (const filePath of paths) {
    const source = project.getSourceFileOrThrow(`/workspace/${filePath}`);
    for (const declaration of namedDeclarations(source)) {
      const name = nameNode(declaration);
      if (!name) continue;
      const id = symbolId(declaration);
      declarations.set(id, declaration);
      graph.nodes.push({
        id,
        path: filePath,
        exports: [],
        kind: kind(declaration),
        name: name.getText(),
        startLine: declaration.getStartLineNumber(),
        endLine: declaration.getEndLineNumber(),
      });
      const evidenceId = `${filePath}:${name.getStart()}:contains:${id}`;
      graph.evidence.push({
        id: evidenceId,
        filePath,
        startLine: name.getStartLineNumber(),
        endLine: name.getEndLineNumber(),
        snippet: name.getText(),
      });
      graph.edges.push({
        id: evidenceId,
        source: filePath,
        target: id,
        kind: "contains",
        confidence: "confirmed",
        evidenceId,
      });
    }
  }
  for (const filePath of paths) {
    const source = project.getSourceFileOrThrow(`/workspace/${filePath}`);
    for (const identifier of source.getDescendantsOfKind(
      SyntaxKind.Identifier,
    )) {
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
      let sourceId = filePath;
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
      const id = `${filePath}:${identifier.getStart()}:references:${target}`;
      graph.evidence.push({
        id,
        filePath,
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
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getKind() === SyntaxKind.ImportKeyword) continue;
      const symbol = unalias(call.getExpression().getSymbol());
      const targets = (symbol?.getDeclarations() ?? [])
        .map(symbolId)
        .filter((id) => declarations.has(id));
      const unique = [...new Set(targets)];
      if (unique.length !== 1) {
        unresolvedCalls++;
        continue;
      }
      let parent: Node | undefined = call.getParent();
      let sourceId = filePath;
      while (parent && !Node.isSourceFile(parent)) {
        const id = symbolId(parent);
        if (declarations.has(id)) {
          sourceId = id;
          break;
        }
        parent = parent.getParent();
      }
      const target = unique[0];
      const id = `${filePath}:${call.getStart()}:calls:${target}`;
      graph.evidence.push({
        id,
        filePath,
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
  return unresolvedCalls;
}

export function resolveTarget(node: Node, graph: GraphParts): string | null {
  const ids = new Set(
    graph.nodes
      .filter((item) => item.kind && item.kind !== "file")
      .map((item) => item.id),
  );
  const targets = [
    ...new Set(
      (unalias(node.getSymbol())?.getDeclarations() ?? [])
        .map(symbolId)
        .filter((id) => ids.has(id)),
    ),
  ];
  return targets.length === 1 ? targets[0] : null;
}
export function ownerId(node: Node, graph: GraphParts): string {
  const ids = new Set(
    graph.nodes
      .filter((item) => item.kind === "function" || item.kind === "method")
      .map((item) => item.id),
  );
  let current: Node | undefined = node.getParent();
  while (current && !Node.isSourceFile(current)) {
    const id = symbolId(current);
    if (ids.has(id)) return id;
    current = current.getParent();
  }
  return relative(node.getSourceFile());
}
