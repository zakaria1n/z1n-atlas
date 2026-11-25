import { Node } from "ts-morph";
import { evidence, type SymbolContext } from "./framework-graph";
import { ownerId, resolveTarget } from "./symbols-and-calls";
import { addManifestEvidence } from "./next-manifest";

/**
 * React conventions that a journey can follow: an event attribute leading to
 * its handler, and a component rendering another component. Both rest on the
 * same proof that a file really is React code, an import of `react` or a
 * package manifest that declares it.
 */
export function addReactRelationships(context: SymbolContext): void {
  const { graph, manifests } = context;
  for (const { path, source, jsxAttributes, jsxElements } of context.sources) {
    if (!context.reactFiles.has(path)) continue;
    const reactImport = source
      .getImportDeclarations()
      .find((declaration) => declaration.getModuleSpecifierValue() === "react");
    const manifest = reactImport ? null : manifests.react(path);
    const prove = reactImport
      ? () => evidence(reactImport, graph)
      : manifest
        ? () => addManifestEvidence(manifest, graph)
        : null;
    if (!prove) continue;
    for (const attribute of jsxAttributes) {
      if (!/^on[A-Z]/.test(attribute.getNameNode().getText())) continue;
      const initializer = attribute.getInitializer();
      const expression =
        initializer && Node.isJsxExpression(initializer)
          ? initializer.getExpression()
          : undefined;
      if (
        !expression ||
        !(
          Node.isIdentifier(expression) ||
          Node.isPropertyAccessExpression(expression)
        )
      )
        continue;
      const sourceId = ownerId(attribute, context);
      const target = resolveTarget(expression, context);
      if (!target || sourceId === target || sourceId === path) continue;
      const evidenceId = evidence(attribute, graph);
      const supportingEvidenceId = prove();
      graph.edges.push({
        id: `${evidenceId}:handles-event:${target}`,
        source: sourceId,
        target,
        kind: "handles-event",
        confidence: "framework",
        evidenceId,
        supportingEvidenceIds: [supportingEvidenceId],
      });
    }
    for (const element of jsxElements) {
      const tag = element.getTagNameNode();
      if (!(Node.isIdentifier(tag) || Node.isPropertyAccessExpression(tag)))
        continue;
      const target = resolveTarget(tag, context);
      const sourceId = ownerId(element, context);
      // Without an enclosing function the element is not rendered by a
      // component this graph knows, so it is not reported as one.
      if (!target || sourceId === target || sourceId === path) continue;
      const evidenceId = evidence(element, graph);
      const supportingEvidenceId = prove();
      graph.edges.push({
        id: `${evidenceId}:renders:${target}`,
        source: sourceId,
        target,
        kind: "renders",
        confidence: "framework",
        evidenceId,
        supportingEvidenceIds: [supportingEvidenceId],
      });
    }
  }
}
