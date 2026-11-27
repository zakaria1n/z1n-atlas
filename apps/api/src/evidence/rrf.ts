/**
 * Reciprocal rank fusion with the GitNexus reference constant k=60:
 * score = sum(1 / (k + rank)) with ranks starting at 1. Identities are
 * caller-chosen (symbol node ids), so distinct functions of one file
 * never collapse.
 */
export function rrfFuse(
  rankedA: string[],
  rankedB: string[],
  limit: number,
  k = 60,
): string[] {
  const scores = new Map<string, number>();
  for (const list of [rankedA, rankedB])
    list.forEach((identity, position) => {
      scores.set(
        identity,
        (scores.get(identity) ?? 0) + 1 / (k + position + 1),
      );
    });
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([identity]) => identity);
}
