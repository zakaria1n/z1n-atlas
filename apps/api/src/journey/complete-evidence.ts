import type { CodeGraph, Journey } from "@z1n/contracts";

/** Add transaction sites only for a path function that owns an identified write. */
export function completePersistenceEvidence(
  journey: Journey,
  graph: CodeGraph,
  question: string,
): Journey {
  if (
    !/\b(book\w*|reserv\w*|persist\w*|sav\w*|writ\w*|commit\w*|transaction\w*|database)\b/i.test(
      question,
    )
  )
    return journey;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const related = [...(journey.relatedOperations ?? [])];
  for (const ownerId of journey.nodeIds) {
    const edges = graph.edges.filter(
      (edge) => edge.source === ownerId && edge.kind === "database-access",
    );
    const writes = edges.filter((edge) =>
      /\bwrite\b/i.test(nodes.get(edge.target)?.name ?? ""),
    );
    const selected = writes.filter((edge) =>
      related.some((item) => item.edgeId === edge.id),
    );
    const write =
      selected.length === 1
        ? selected[0]
        : writes.length === 1
          ? writes[0]
          : undefined;
    if (!write) continue;
    for (const edge of edges) {
      const name = nodes.get(edge.target)?.name ?? "";
      if (edge.id !== write.id && !/\b(flush|commit|rollback)\b/i.test(name))
        continue;
      if (
        !related.some((item) => item.edgeId === edge.id) &&
        related.length < 24
      )
        related.push({ ownerId, nodeId: edge.target, edgeId: edge.id });
    }
  }
  if (related.length === (journey.relatedOperations ?? []).length)
    return journey;
  return {
    ...journey,
    relatedOperations: related,
    uncertainties: [
      ...journey.uncertainties.slice(0, 7),
      "Related transaction sites are static source evidence; they may belong to different branches or transactions; rollback may be conditional, and source order does not prove execution.",
    ],
  };
}

export function qualifyUnsupportedAbsence(text: string): string {
  return /\b(?:no|never|cannot|does not|doesn't)\b.*\b(?:exist|exists|mechanism|feature|support|receive|send)\b/i.test(
    text,
  )
    ? "The available evidence is insufficient to establish whether this behavior exists."
    : text;
}
