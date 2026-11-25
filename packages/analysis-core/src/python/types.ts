import type { GraphParts } from "../framework-graph";
import type { HttpRequestFact, HttpRouteFact } from "../http-match";

/** The outcome of analyzing one language's share of the selection. */
export type LanguageAnalysis = {
  parts: GraphParts;
  routes: HttpRouteFact[];
  requests: HttpRequestFact[];
  unresolved: number;
  unresolvedCalls: number;
};

export const emptyAnalysis = (): LanguageAnalysis => ({
  parts: { nodes: [], edges: [], evidence: [], unresolvedItems: [] },
  routes: [],
  requests: [],
  unresolved: 0,
  unresolvedCalls: 0,
});

export type PyImport = {
  statement: "import" | "from";
  /** The dotted module path for `from` imports; undefined for a bare relative import. */
  module?: string;
  /** Number of leading dots of a relative import; 0 when absolute. */
  level: number;
  names: { name: string; alias?: string }[];
  wildcard: boolean;
  start: number;
  end: number;
  text: string;
};

export type PyDecorator = {
  /** The dotted receiver of `@receiver.verb(...)`, or the bare decorator name. */
  receiver: string;
  /** The attribute called on the receiver; null for a bare `@name` decorator. */
  verb: string | null;
  args: PyExpr[];
  start: number;
  end: number;
};

export type PyParameter = { name: string; annotation?: string };

export type PyDef = {
  name: string;
  id: string;
  /** Set when the function is defined in a class body. */
  className?: string;
  kind: "function" | "method";
  decorators: PyDecorator[];
  parameters: PyParameter[];
  start: number;
  end: number;
};

export type PyClass = {
  name: string;
  id: string;
  superclasses: string[];
  hasTableName: boolean;
  start: number;
  end: number;
};

export type PyAssignment = {
  name: string;
  start: number;
  end: number;
  value: PyExpr;
};

export type PyCall = {
  callee: PyExpr & { kind: "identifier" | "attribute" };
  args: PyExpr[];
  keywordArgs: { key: string; value: PyExpr }[];
  /** Index of the nearest enclosing definition in the file, or -1 at module level. */
  owner: number;
  start: number;
  end: number;
};

export type PyExpr = {
  kind: "identifier" | "attribute" | "call" | "string" | "binary" | "other";
  /** The final name of an identifier or attribute chain. */
  name?: string;
  /** The dotted text of the receiver of an attribute, or the chain itself for an identifier. */
  receiverText?: string;
  args?: PyExpr[];
  keywordArgs?: { key: string; value: PyExpr }[];
  /** A plain string literal without interpolation. */
  stringValue?: string;
  left?: PyExpr;
  right?: PyExpr;
  start: number;
  end: number;
  text: string;
};

export type PyModule = {
  path: string;
  fileId: string;
  exports: string[];
  imports: PyImport[];
  defs: PyDef[];
  classes: PyClass[];
  assignments: PyAssignment[];
  calls: PyCall[];
  /** Local `name = Constructor(...)` bindings, which give variables a type. */
  bindings: { owner: number; name: string; constructor: string }[];
  /** Classes that look like ORM models. */
  models: Set<string>;
  /** Router and application instances declared at module level, with their stated prefix. */
  routers: Map<string, { prefix: string | null; start: number }>;
  apps: Set<string>;
  /** `<host>.include_router(...)` calls, wherever they appear. */
  includes: {
    host: string;
    child: PyExpr;
    prefix: string | null;
    start: number;
  }[];
  constants: Map<string, string>;
};
