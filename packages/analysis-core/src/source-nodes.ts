import {
  SyntaxKind,
  ts,
  type CallExpression,
  type Identifier,
  type JsxAttribute,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";

/**
 * Nodes of one source file that the analysis passes use, gathered in a single
 * traversal so that each file is walked once instead of once per pass.
 */
export type SourceNodes = {
  path: string;
  source: SourceFile;
  /** Identifiers that can resolve to a tracked declaration by name. */
  identifiers: Identifier[];
  calls: CallExpression[];
  /** Variables initialized by a call, such as `const app = express()`. */
  callVariables: VariableDeclaration[];
  /** Functions, methods, classes, then function-valued variables and properties. */
  declarations: Node[];
  jsxAttributes: JsxAttribute[];
};

function nameText(name: ts.Node, source: ts.SourceFile): string {
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name)
    ? name.text
    : name.getText(source);
}

/**
 * Returns the name when the node is a declaration that becomes a symbol node.
 * This works on raw compiler nodes so that names can be gathered without
 * creating wrappers, and it is the single definition of a tracked declaration.
 */
function trackedName(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
    return node.name && node.body ? nameText(node.name, source) : undefined;
  if (ts.isClassDeclaration(node))
    return node.name ? nameText(node.name, source) : undefined;
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
    const { initializer } = node;
    return initializer &&
      ts.isIdentifier(node.name) &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ? node.name.text
      : undefined;
  }
  return undefined;
}

export type SymbolNames = {
  /** Names of declarations that become symbol nodes. */
  declared: Set<string>;
  /** Declared names plus every identifier inside import and export statements, because an alias may differ from the name it refers to. */
  any: Set<string>;
};

/**
 * Names that can resolve to a tracked declaration. A plain identifier reaches
 * a declaration either by its declared name or through an import or export
 * alias, while a property access only ever reaches a declared member name.
 */
export function candidateNames(sources: SourceFile[]): SymbolNames {
  const declared = new Set<string>();
  const any = new Set<string>();
  const visit = (node: ts.Node, source: ts.SourceFile): void => {
    const name = trackedName(node, source);
    if (name !== undefined) declared.add(name);
    ts.forEachChild(node, (child) => visit(child, source));
  };
  const visitModuleStatement = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) any.add(node.text);
    ts.forEachChild(node, visitModuleStatement);
  };
  for (const source of sources) {
    const raw = source.compilerNode;
    ts.forEachChild(raw, (node) => visit(node, raw));
    for (const statement of raw.statements)
      if (
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)
      )
        visitModuleStatement(statement);
  }
  return { declared, any: new Set([...declared, ...any]) };
}

export function collectSourceNodes(
  source: SourceFile,
  names: SymbolNames,
): SourceNodes {
  const raw = source.compilerNode;
  const functions: Node[] = [];
  const methods: Node[] = [];
  const classes: Node[] = [];
  const variables: VariableDeclaration[] = [];
  const properties: Node[] = [];
  const nodes: SourceNodes = {
    path: source.getFilePath().replace(/^\/workspace\//, ""),
    source,
    identifiers: [],
    calls: [],
    callVariables: [],
    declarations: [],
    jsxAttributes: [],
  };
  source.forEachDescendant((node) => {
    switch (node.getKind()) {
      case SyntaxKind.Identifier: {
        const identifier = node.compilerNode as ts.Identifier;
        const propertyName =
          ts.isPropertyAccessExpression(identifier.parent) &&
          identifier.parent.name === identifier;
        if ((propertyName ? names.declared : names.any).has(identifier.text))
          nodes.identifiers.push(node as Identifier);
        break;
      }
      case SyntaxKind.CallExpression:
        nodes.calls.push(node as CallExpression);
        break;
      case SyntaxKind.JsxAttribute:
        nodes.jsxAttributes.push(node as JsxAttribute);
        break;
      case SyntaxKind.FunctionDeclaration:
        if (trackedName(node.compilerNode, raw) !== undefined)
          functions.push(node);
        break;
      case SyntaxKind.MethodDeclaration:
        if (trackedName(node.compilerNode, raw) !== undefined)
          methods.push(node);
        break;
      case SyntaxKind.ClassDeclaration:
        if (trackedName(node.compilerNode, raw) !== undefined)
          classes.push(node);
        break;
      case SyntaxKind.PropertyDeclaration:
        if (trackedName(node.compilerNode, raw) !== undefined)
          properties.push(node);
        break;
      case SyntaxKind.VariableDeclaration:
        if (!ts.isVariableDeclaration(node.compilerNode)) break;
        if (trackedName(node.compilerNode, raw) !== undefined)
          variables.push(node as VariableDeclaration);
        else if (
          node.compilerNode.initializer &&
          ts.isCallExpression(node.compilerNode.initializer)
        )
          nodes.callVariables.push(node as VariableDeclaration);
        break;
    }
  });
  nodes.declarations = [
    ...functions,
    ...methods,
    ...classes,
    ...variables,
    ...properties,
  ];
  return nodes;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true
  );
}

/**
 * Whether a declaration carries an `export` or `default` modifier itself or
 * through the statement that contains it. Deciding this from syntax avoids
 * asking the type checker once per declaration.
 */
export function hasExportModifier(node: ts.Node, container: ts.Node): boolean {
  return (
    hasModifier(container, SyntaxKind.ExportKeyword) ||
    hasModifier(node, SyntaxKind.ExportKeyword) ||
    hasModifier(node, SyntaxKind.DefaultKeyword)
  );
}

/** Names listed by `export { a as b }` statements that have no module specifier. */
export function localExportNames(source: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.compilerNode.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue;
    for (const element of statement.exportClause.elements)
      names.add((element.propertyName ?? element.name).text);
  }
  return names;
}
