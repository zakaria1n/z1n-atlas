import type { Node as TsNode } from "web-tree-sitter";
import type { ParsedPython } from "./parser";
import type { PyCall, PyDecorator, PyExpr, PyModule } from "./types";

/** The first child stored under a grammar field name, if there is one. */
function field(node: TsNode, name: string): TsNode | null {
  return (
    node as unknown as { childForFieldName: (n: string) => TsNode | null }
  ).childForFieldName(name);
}

/** The named children of a node, without the null placeholders. */
function kids(node: TsNode): TsNode[] {
  return node.namedChildren.filter((child): child is TsNode => child !== null);
}

/** The dotted spelling of a plain identifier/attribute chain, or its raw text. */
function dottedText(node: TsNode): string {
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") {
    const object = field(node, "object");
    const attribute = field(node, "attribute");
    if (object && attribute && isPlainChain(object))
      return `${dottedText(object)}.${attribute.text}`;
  }
  return node.text;
}

function isPlainChain(node: TsNode): boolean {
  return (
    node.type === "identifier" ||
    (node.type === "attribute" && isPlainChain(field(node, "object")!))
  );
}

/** The positional and keyword arguments of a call node. */
function callArgs(call: TsNode): {
  args: PyExpr[];
  keywordArgs: { key: string; value: PyExpr }[];
} {
  const args: PyExpr[] = [];
  const keywordArgs: { key: string; value: PyExpr }[] = [];
  for (const child of kids(field(call, "arguments")!)) {
    if (child.type === "keyword_argument")
      keywordArgs.push({
        key: field(child, "name")!.text,
        value: exprOf(field(child, "value")!),
      });
    else if (child.type !== "list_splat" && child.type !== "dictionary_splat")
      args.push(exprOf(child));
  }
  return { args, keywordArgs };
}

/** Turns an expression subtree into the structured form the passes read. */
export function exprOf(node: TsNode): PyExpr {
  const base = { start: node.startIndex, end: node.endIndex, text: node.text };
  switch (node.type) {
    case "identifier":
      return {
        kind: "identifier",
        name: node.text,
        receiverText: node.text,
        ...base,
      };
    case "attribute":
      return {
        kind: "attribute",
        name: field(node, "attribute")?.text,
        receiverText: dottedText(node),
        ...base,
      };
    case "call": {
      const callee = exprOf(field(node, "function")!);
      return {
        kind: "call",
        // The constructor or function a call names, without its arguments.
        receiverText:
          callee.kind === "attribute"
            ? callee.receiverText
            : callee.kind === "identifier"
              ? callee.name
              : undefined,
        name: callee.name,
        ...callArgs(node),
        ...base,
      };
    }
    case "string": {
      const content = kids(node).find(
        (child) => child.type === "string_content",
      );
      return kids(node).some((child) => child.type === "interpolation")
        ? { kind: "other", ...base }
        : { kind: "string", stringValue: content?.text ?? "", ...base };
    }
    case "binary_operator":
      return field(node, "operator")?.text === "+"
        ? {
            kind: "binary",
            left: exprOf(field(node, "left")!),
            right: exprOf(field(node, "right")!),
            ...base,
          }
        : { kind: "other", ...base };
    default:
      return { kind: "other", ...base };
  }
}

function decoratorOf(node: TsNode): PyDecorator | null {
  const inner = kids(node)[0];
  if (!inner) return null;
  if (inner.type === "call") {
    const callee = exprOf(field(inner, "function")!);
    if (callee.kind !== "attribute" && callee.kind !== "identifier")
      return null;
    return {
      receiver:
        callee.kind === "attribute" ? callee.receiverText! : callee.name!,
      verb: callee.kind === "attribute" ? callee.name! : null,
      args: callArgs(inner).args,
      start: inner.startIndex,
      end: inner.endIndex,
    };
  }
  if (inner.type === "identifier" || inner.type === "attribute")
    return {
      receiver: dottedText(inner),
      verb: null,
      args: [],
      start: inner.startIndex,
      end: inner.endIndex,
    };
  return null;
}

/** Names and annotations of a function's parameters. */
function parametersOf(functionNode: TsNode): {
  name: string;
  annotation?: string;
}[] {
  const parameters = field(functionNode, "parameters");
  if (!parameters) return [];
  const result: { name: string; annotation?: string }[] = [];
  for (const child of kids(parameters)) {
    const name = field(child, "name");
    if (name) {
      const type = field(child, "type");
      result.push({
        name: name.text,
        annotation: type ? dottedText(type) : undefined,
      });
    } else if (child.type === "identifier") result.push({ name: child.text });
    else if (child.type === "typed_parameter") {
      const inner = kids(child)[0];
      if (inner)
        result.push({
          name: dottedText(inner),
          annotation: dottedText(kids(child).at(-1)!),
        });
    }
  }
  return result;
}

/**
 * One traversal per file collects every fact the passes need: imports,
 * definitions, module assignments, calls and framework entry points. Calls
 * record their nearest enclosing definition so ownership matches the graph
 * nodes, and decorators are captured structurally instead of as plain calls.
 */
export function walkPython(file: ParsedPython): PyModule {
  const facts: PyModule = {
    path: file.path,
    fileId: file.path,
    exports: [],
    imports: [],
    defs: [],
    classes: [],
    assignments: [],
    calls: [],
    bindings: [],
    models: new Set(),
    routers: new Map(),
    apps: new Set(),
    includes: [],
    constants: new Map(),
  };
  const defStack: number[] = [];
  let currentClass: string | null = null;

  function addDef(node: TsNode, decorators: PyDecorator[]): void {
    const name = field(node, "name")!.text;
    const owner =
      facts.defs.push({
        name,
        id: `${file.path}#${node.startIndex}`,
        className: currentClass ?? undefined,
        kind: currentClass ? "method" : "function",
        decorators,
        parameters: parametersOf(node),
        start: node.startIndex,
        end: node.endIndex,
      }) - 1;
    if (!currentClass) facts.exports.push(name);
    else if (!facts.exports.includes(currentClass))
      facts.exports.push(currentClass);
    defStack.push(owner);
    visit(field(node, "body")!);
    defStack.pop();
  }

  function addClass(node: TsNode): void {
    const name = field(node, "name")!.text;
    const superclasses = field(node, "superclasses");
    facts.classes.push({
      name,
      id: `${file.path}#${node.startIndex}`,
      superclasses: superclasses
        ? kids(superclasses).map((child) => dottedText(child))
        : [],
      hasTableName: node.text.includes("__tablename__"),
      start: node.startIndex,
      end: node.endIndex,
    });
    facts.exports.push(name);
    const previous = currentClass;
    currentClass = name;
    visit(field(node, "body")!);
    currentClass = previous;
  }

  function visit(node: TsNode): void {
    switch (node.type) {
      case "import_statement": {
        const names: { name: string; alias?: string }[] = [];
        for (const child of kids(node)) {
          if (child.type === "dotted_name") names.push({ name: child.text });
          else if (child.type === "aliased_import") {
            const [dotted, alias] = kids(child);
            names.push({ name: dotted?.text ?? "", alias: alias?.text });
          }
        }
        facts.imports.push({
          statement: "import",
          level: 0,
          names,
          wildcard: false,
          start: node.startIndex,
          end: node.endIndex,
          text: node.text,
        });
        return;
      }
      case "import_from_statement": {
        let level = 0;
        let moduleName: string | undefined;
        const names: { name: string; alias?: string }[] = [];
        let wildcard = false;
        let lookingForModule = true;
        for (const child of kids(node)) {
          if (child.type === "relative_import") {
            level = kids(child).filter(
              (part) => part.type === "import_prefix",
            ).length;
            const dotted = kids(child).find(
              (part) => part.type === "dotted_name",
            );
            if (dotted) moduleName = dotted.text;
            lookingForModule = false;
          } else if (child.type === "dotted_name" && lookingForModule) {
            moduleName = child.text;
            lookingForModule = false;
          } else if (child.type === "dotted_name")
            names.push({ name: child.text });
          else if (child.type === "aliased_import") {
            const dotted = kids(child).find(
              (part) => part.type === "dotted_name",
            );
            const alias = kids(child).find(
              (part) => part.type === "identifier",
            );
            names.push({ name: dotted?.text ?? "", alias: alias?.text });
            lookingForModule = false;
          } else if (child.type === "wildcard_import") wildcard = true;
        }
        facts.imports.push({
          statement: "from",
          module: moduleName,
          level,
          names,
          wildcard,
          start: node.startIndex,
          end: node.endIndex,
          text: node.text,
        });
        return;
      }
      case "decorated_definition": {
        const decorators: PyDecorator[] = [];
        for (const child of kids(node))
          if (child.type === "decorator") {
            const decorator = decoratorOf(child);
            if (decorator) decorators.push(decorator);
          }
        const definition = kids(node).find(
          (child) =>
            child.type === "function_definition" ||
            child.type === "class_definition",
        );
        if (definition?.type === "class_definition") addClass(definition);
        else if (definition) addDef(definition, decorators);
        return;
      }
      case "class_definition":
        addClass(node);
        return;
      case "function_definition":
        addDef(node, []);
        return;
      case "expression_statement": {
        const inner = kids(node)[0];
        if (inner?.type === "assignment") {
          const left = field(inner, "left");
          const right = field(inner, "right");
          if (left?.type === "identifier" && right) {
            const value = exprOf(right);
            if (node.parent?.type === "module") {
              facts.assignments.push({
                name: left.text,
                start: inner.startIndex,
                end: inner.endIndex,
                value,
              });
              if (value.kind === "string")
                facts.constants.set(left.text, value.stringValue ?? "");
            }
            // A constructor bound to a local variable gives that variable a
            // type, which session operations rely on.
            if (defStack.length && value.kind === "call" && value.receiverText)
              facts.bindings.push({
                owner: defStack.at(-1)!,
                name: left.text,
                constructor: value.receiverText,
              });
          }
        }
        for (const child of kids(node)) visit(child);
        return;
      }
      case "call": {
        const callee = exprOf(field(node, "function")!);
        if (callee.kind === "identifier" || callee.kind === "attribute") {
          const { args, keywordArgs } = callArgs(node);
          facts.calls.push({
            callee: callee as PyCall["callee"],
            args,
            keywordArgs,
            owner: defStack.at(-1) ?? -1,
            start: node.startIndex,
            end: node.endIndex,
          });
          if (callee.kind === "attribute" && callee.name === "include_router") {
            const prefixArg = keywordArgs.find(
              (item) => item.key === "prefix",
            )?.value;
            facts.includes.push({
              host: callee.receiverText!,
              child: args[0] ?? { kind: "other", start: 0, end: 0, text: "" },
              prefix: prefixArg
                ? foldConstants(prefixArg, facts.constants)
                : null,
              start: node.startIndex,
            });
          }
        }
        // Calls nested inside arguments (constructors handed to session.add,
        // select() queries) are relationships of their own, so keep walking.
        for (const child of kids(field(node, "arguments")!)) visit(child);
        return;
      }
      default:
        for (const child of kids(node)) visit(child);
    }
  }

  visit(file.tree.rootNode);
  for (const { name, value } of facts.assignments) {
    if (value.kind !== "call") continue;
    const constructor = value.receiverText;
    if (constructor === "APIRouter")
      facts.routers.set(name, {
        prefix: value.keywordArgs?.find((item) => item.key === "prefix")
          ? foldConstants(
              value.keywordArgs.find((item) => item.key === "prefix")!.value,
              facts.constants,
            )
          : "",
        start: value.start,
      });
    else if (constructor === "FastAPI") facts.apps.add(name);
  }
  return facts;
}

/** Folds string literals, module constants and their concatenations. */
export function foldConstants(
  expr: PyExpr,
  constants: Map<string, string>,
  depth = 4,
): string | null {
  if (depth < 0) return null;
  if (expr.kind === "string") return expr.stringValue ?? null;
  if (expr.kind === "identifier") return constants.get(expr.name!) ?? null;
  if (expr.kind === "binary") {
    const left = foldConstants(expr.left!, constants, depth - 1);
    const right = foldConstants(expr.right!, constants, depth - 1);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}
