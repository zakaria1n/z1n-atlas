import { Node, SyntaxKind } from "ts-morph";
import {
  addNode,
  evidence,
  relative,
  type SymbolContext,
} from "./framework-graph";
import { ownerId, unalias } from "./symbols-and-calls";
const operations = new Set([
  "create",
  "createMany",
  "findFirst",
  "findUnique",
  "findMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "aggregate",
  "count",
  "groupBy",
]);
function prismaClient(
  node: Node,
): { declaration: Node; importNode: Node } | null {
  if (!Node.isIdentifier(node)) return null;
  const declaration = unalias(node.getSymbol())
    ?.getDeclarations()
    .find(Node.isVariableDeclaration);
  if (!declaration) return null;
  const initializer = declaration.getInitializer();
  if (!initializer) return null;
  const constructor = findPrismaConstructor(initializer, declaration);
  if (!constructor || !Node.isIdentifier(constructor)) return null;
  const imports = constructor.getSymbol()?.getDeclarations() ?? [];
  for (const item of imports) {
    const statement = item.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (!statement || statement.getModuleSpecifierValue() !== "@prisma/client")
      continue;
    if (
      statement
        .getNamedImports()
        .some(
          (specifier) =>
            specifier.getName() === "PrismaClient" &&
            (specifier.getAliasNode()?.getText() ?? specifier.getName()) ===
              constructor.getText(),
        )
    )
      return { declaration: initializer, importNode: statement };
  }
  return null;
}
/** Any `new PrismaClient(...)` construction inside a node's subtree. */
function prismaConstructionIn(node: Node): Node | undefined {
  for (const candidate of node.getDescendants()) {
    if (!Node.isNewExpression(candidate)) continue;
    if (Node.isIdentifier(candidate.getExpression()))
      return candidate.getExpression();
  }
  return undefined;
}
/**
 * Follows one hop through a local factory called by the initializer: the
 * common `global.prisma ?? makeClient()` singleton pattern constructs the
 * client inside the factory's return statement.
 */
function factoryConstructorIn(
  declaration: Node,
  initializer: Node,
): Node | undefined {
  for (const candidate of initializer.getDescendants()) {
    if (
      !Node.isCallExpression(candidate) ||
      !Node.isIdentifier(candidate.getExpression())
    )
      continue;
    const name = candidate.getExpression().getText();
    const source = declaration.getSourceFile();
    // Factories are declared either as functions or as arrow functions
    // assigned to variables (`const makeClient = () => new PrismaClient()`).
    const factory = source.getFunction(name)?.getBody();
    const variable = source.getVariableDeclaration(name);
    const arrow = variable?.getInitializer();
    const body =
      factory ??
      (arrow && Node.isArrowFunction(arrow) ? arrow.getBody() : undefined);
    if (!body) continue;
    return prismaConstructionIn(body);
  }
  return undefined;
}
function findPrismaConstructor(
  initializer: Node,
  declaration: Node,
): Node | undefined {
  if (Node.isNewExpression(initializer)) return initializer.getExpression();
  return (
    prismaConstructionIn(initializer) ??
    factoryConstructorIn(declaration, initializer)
  );
}
export function addPrismaAccess(context: SymbolContext): void {
  const { graph } = context;
  for (const { calls } of context.sources) {
    for (const call of calls) {
      const expression = call.getExpression();
      if (
        !Node.isPropertyAccessExpression(expression) ||
        !operations.has(expression.getName())
      )
        continue;
      const model = expression.getExpression();
      if (!Node.isPropertyAccessExpression(model)) continue;
      const client = prismaClient(model.getExpression());
      if (!client) continue;
      const filePath = relative(call),
        id = `${filePath}#database:${call.getStart()}`,
        evidenceId = evidence(call, graph);
      addNode(
        call,
        id,
        `Prisma ${model.getName()}.${expression.getName()}`,
        "database",
        graph,
      );
      graph.edges.push({
        id: `${id}:access`,
        source: ownerId(call, context),
        target: id,
        kind: "database-access",
        confidence: "framework",
        evidenceId,
        supportingEvidenceIds: [
          evidence(client.declaration, graph),
          evidence(client.importNode, graph),
        ],
      });
    }
  }
}
