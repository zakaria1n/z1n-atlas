import type { GraphEdge } from "@z1n/contracts";

/**
 * Relationships a journey may follow: the ones that can carry an execution
 * or a render. Imports and plain references say what a file knows about,
 * not what runs.
 */
export const journeyKinds: ReadonlySet<GraphEdge["kind"]> = new Set([
  "calls",
  "requests",
  "http-route",
  "handles",
  "handles-event",
  "database-access",
  "renders",
]);
