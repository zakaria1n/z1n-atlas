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
  const initializer = declaration?.getInitializer();
  if (!initializer || !Node.isNewExpression(initializer)) return null;
  const constructor = initializer.getExpression();
  if (!Node.isIdentifier(constructor)) return null;
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
