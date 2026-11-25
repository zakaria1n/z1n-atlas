import {
  addUnresolvedLocation,
  type GraphParts,
  type SourceLocation,
} from "./framework-graph";

/** A route an analyzed file serves, in a form independent of the language. */
export type HttpRouteFact = {
  nodeId: string;
  path: string;
  method: string;
  evidenceId: string;
  supportingEvidenceIds?: string[];
};
/** A request an analyzed file makes, in a form independent of the language. */
export type HttpRequestFact = {
  nodeId: string;
  url: string;
  method: string;
  evidenceId: string;
  location: SourceLocation;
};
export type { GraphParts };

/** A path segment that stands for any value, on either side of a match. */
function isParameter(segment: string): boolean {
  return /^\{[^/]+\}$/.test(segment);
}
/** A segment with its parameter markers removed, for partial-literal compares. */
function literalPart(segment: string): string {
  return segment.replace(/\{[^/}]*\}/g, "");
}
/** A request path and a route path describe the same resource. */
function sameAddress(requestPath: string, routePath: string): boolean {
  const request = requestPath.split("/");
  const route = routePath.split("/");
  return (
    request.length === route.length &&
    request.every((segment, index) => {
      const routeSegment = route[index];
      return (
        segment === routeSegment ||
        isParameter(segment) ||
        isParameter(routeSegment) ||
        // A parameter written inside a literal segment ("{param}complexes")
        // still names the same segment as the route's literal spelling.
        (literalPart(segment) !== "" &&
          literalPart(segment) === literalPart(routeSegment))
      );
    })
  );
}

/**
 * Connects a request to the route that serves it. The match is heuristic:
 * a client and a server agree on an address, which is strong evidence of a
 * relationship but not a verified call. Exactly one route must match, and a
 * request without a match is reported instead of guessed.
 */
export function matchHttp(
  requests: HttpRequestFact[],
  routes: HttpRouteFact[],
  graph: GraphParts,
): number {
  let unmatched = 0;
  for (const request of requests) {
    const matched = routes.filter(
      (route) =>
        sameAddress(request.url, route.path) &&
        (route.method === request.method ||
          route.method === "ALL" ||
          route.method === "ANY"),
    );
    if (matched.length !== 1) {
      unmatched++;
      addUnresolvedLocation(
        graph,
        request.location,
        "request",
        matched.length
          ? `More than one analyzed route matches ${request.method} ${request.url}.`
          : `No analyzed route matches ${request.method} ${request.url}.`,
      );
      continue;
    }
    const route = matched[0];
    graph.edges.push({
      id: `${request.nodeId}:route:${route.nodeId}`,
      source: request.nodeId,
      target: route.nodeId,
      kind: "http-route",
      confidence: "heuristic",
      evidenceId: request.evidenceId,
      supportingEvidenceIds: [
        route.evidenceId,
        ...(route.supportingEvidenceIds ?? []),
      ],
    });
  }
  return unmatched;
}
