import {
  Node,
  SyntaxKind,
  ts,
  type CallExpression,
  type Identifier,
  type JsxAttribute,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type Node as MorphNode,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";
import { constantString } from "./symbols-and-calls";
import { workspacePath } from "./workspace";

export type SymbolNames = {
  /** Names of declarations that become symbol nodes. */
  declared: Set<string>;
  /** Declared names plus every identifier inside import and export statements, because an alias may differ from the name it refers to. */
  any: Set<string>;
};

export type AnonymousFunction = {
  node: MorphNode;
  name: string;
};

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
  /**
   * Functions, methods, classes, function-valued variables, class properties
   * and object members, in that order.
   */
  declarations: MorphNode[];
  jsxAttributes: JsxAttribute[];
  /** JSX elements, which may render another component. */
  jsxElements: (JsxOpeningElement | JsxSelfClosingElement)[];
  /** Nameless functions that receive a node because a route or page refers to them. */
  anonymous: AnonymousFunction[];
};

/** Route methods of Express and Fastify routers, in lowercase as written in code. */
export const httpVerbs = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
]);

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
  // A function assigned to a named member, such as `create: async (x) => {}`
  // in an object literal or `create = () => {}` on a class, is the usual shape
  // of a service or an API client and is tracked like a method.
  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertyAssignment(node)
  ) {
    const { initializer } = node;
    return initializer &&
      ts.isIdentifier(node.name) &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ? node.name.text
      : undefined;
  }
  return undefined;
}

/**
 * A nameless function matters to a journey only when framework code calls
 * it, so it is named after what refers to it: the default export of a module
 * or the route it handles.
 */
function anonymousName(node: MorphNode): string | undefined {
  const parent = node.getParent();
  if (Node.isExportAssignment(parent)) return "default export";
  if (!Node.isCallExpression(parent)) return undefined;
  const args = parent.getArguments();
  if (args.indexOf(node) < 1) return undefined;
  const expression = parent.getExpression();
  if (
    !Node.isPropertyAccessExpression(expression) ||
    !httpVerbs.has(expression.getName().toLowerCase())
  )
    return undefined;
  const route = constantString(args[0]);
  return route?.startsWith("/")
    ? `${expression.getName().toLowerCase()} ${route} callback`
    : undefined;
}

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
  const functions: MorphNode[] = [];
  const methods: MorphNode[] = [];
  const classes: MorphNode[] = [];
  const variables: VariableDeclaration[] = [];
  const properties: MorphNode[] = [];
  const assignments: MorphNode[] = [];
  const nodes: SourceNodes = {
    path: workspacePath(source.getFilePath()),
    source,
    identifiers: [],
    calls: [],
    callVariables: [],
    declarations: [],
    jsxAttributes: [],
    jsxElements: [],
    anonymous: [],
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
      case SyntaxKind.JsxOpeningElement:
      case SyntaxKind.JsxSelfClosingElement:
        nodes.jsxElements.push(
          node as JsxOpeningElement | JsxSelfClosingElement,
        );
        break;
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression: {
        const name = anonymousName(node);
        if (name) nodes.anonymous.push({ node, name });
        break;
      }
      case SyntaxKind.FunctionDeclaration: {
        const declaration = node.compilerNode;
        if (trackedName(declaration, raw) !== undefined) functions.push(node);
        else if (
          ts.isFunctionDeclaration(declaration) &&
          !declaration.name &&
          declaration.body &&
          hasModifier(declaration, SyntaxKind.DefaultKeyword)
        )
          nodes.anonymous.push({ node, name: "default export" });
        break;
      }
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
      case SyntaxKind.PropertyAssignment:
        if (trackedName(node.compilerNode, raw) !== undefined)
          assignments.push(node);
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
    ...assignments,
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
