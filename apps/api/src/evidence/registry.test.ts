import { describe, expect, it } from "vitest";
import { EvidenceRegistry } from "./registry";
import { registerToolResult } from "./tool-registration";
import type { ChatAnswer } from "@z1n/contracts";

type Citation = ChatAnswer["claims"][number]["citations"][number];

describe("shared evidence registry", () => {
  it("accepts verified items until the budget and flags truncation", () => {
    const registry = new EvidenceRegistry(2);
    const base: Citation = {
      id: "a",
      filePath: "a.ts",
      startLine: 1,
      endLine: 1,
      snippet: "a",
    };
    expect(registry.add(base)).toBe(true);
    expect(registry.add({ ...base, id: "b" })).toBe(true);
    expect(registry.add({ ...base, id: "c" })).toBe(false);
    expect(registry.truncated).toBe(true);
    expect(registry.list().map((item) => item.id)).toEqual(["a", "b"]);
    expect(registry.has("a")).toBe(true);
    expect(registry.find("a")?.snippet).toBe("a");
  });
  it("treats duplicate ids as no-ops without truncation", () => {
    const registry = new EvidenceRegistry(1);
    const base: Citation = {
      id: "a",
      filePath: "a.ts",
      startLine: 1,
      endLine: 1,
      snippet: "a",
    };
    expect(registry.add(base)).toBe(true);
    expect(registry.add(base)).toBe(true);
    expect(registry.truncated).toBe(false);
  });
  it("replaces content with refill and keeps the truncation flag", () => {
    const registry = new EvidenceRegistry(4);
    const base: Citation = {
      id: "a",
      filePath: "a.ts",
      startLine: 1,
      endLine: 1,
      snippet: "a",
    };
    registry.add(base);
    registry.add({ ...base, id: "b" });
    registry.refill([{ ...base, id: "z" }]);
    expect(registry.list().map((item) => item.id)).toEqual(["z"]);
  });
});

describe("tool result registration", () => {
  it("registers literal source lines from search and read results", () => {
    const registry = new EvidenceRegistry(10);
    registerToolResult(
      registry,
      { name: "search_code", arguments: '{"query":"x"}' },
      JSON.stringify({
        matches: [
          { path: "a.ts", line: 3, text: "const login = 1;", truncated: false },
        ],
        truncated: false,
      }),
    );
    registerToolResult(
      registry,
      { name: "read_file", arguments: "{}" },
      JSON.stringify({ path: "b.ts", lines: [{ line: 7, text: "export x" }] }),
    );
    expect(registry.has("source:a.ts:3")).toBe(true);
    expect(registry.find("source:a.ts:3")?.snippet).toBe("const login = 1;");
    expect(registry.has("source:b.ts:7")).toBe(true);
    expect(registry.truncated).toBe(false);
  });
  it("registers relationship evidence from graph neighbors", () => {
    const registry = new EvidenceRegistry(10);
    registerToolResult(
      registry,
      { name: "get_graph_neighbors", arguments: "{}" },
      JSON.stringify({
        nodes: [{ id: "n1", name: "create", kind: "function", path: "a.ts" }],
        edges: [
          {
            id: "e1",
            source: "a.ts#1",
            target: "n1",
            kind: "database-access",
            evidenceId: "ev1",
            confidence: "confirmed",
          },
        ],
        evidence: [
          {
            id: "ev1",
            filePath: "a.ts",
            startLine: 2,
            endLine: 4,
            snippet: "prisma.user.create",
          },
        ],
        truncated: false,
      }),
    );
    const item = registry.find("ev1");
    expect(item?.relationship).toEqual({
      edgeId: "e1",
      source: "a.ts#1",
      target: "n1",
      kind: "database-access",
      confidence: "confirmed",
    });
  });
  it("registers node summaries from discovery, symbols and routes", () => {
    const registry = new EvidenceRegistry(10);
    registerToolResult(
      registry,
      { name: "discover_feature", arguments: "{}" },
      JSON.stringify({
        candidates: [
          {
            ref: "n1",
            name: "register",
            kind: "function",
            path: "r.ts",
            line: 4,
          },
        ],
      }),
    );
    registerToolResult(
      registry,
      { name: "find_routes", arguments: "{}" },
      JSON.stringify({
        routes: [
          { nodeId: "n9", route: "POST /api/auth/register", filePath: "rt.ts" },
        ],
      }),
    );
    expect(registry.find("node:n1")?.snippet).toContain("register");
    expect(registry.find("node:n9")?.snippet).toContain(
      "POST /api/auth/register",
    );
  });
  it("ignores malformed or non-JSON output instead of inventing evidence", () => {
    const registry = new EvidenceRegistry(10);
    registerToolResult(
      registry,
      { name: "search_code", arguments: "{}" },
      "the tool rejected this call",
    );
    registerToolResult(
      registry,
      { name: "search_code", arguments: "{}" },
      "42",
    );
    expect(registry.size).toBe(0);
  });
  it("enforces the shared budget across multiple tool answers", () => {
    const registry = new EvidenceRegistry(2);
    const matches = Array.from({ length: 5 }, (_, index) => ({
      path: "a.ts",
      line: index + 1,
      text: `line ${index + 1}`,
    }));
    registerToolResult(
      registry,
      { name: "search_code", arguments: "{}" },
      JSON.stringify({ matches, truncated: true }),
    );
    expect(registry.size).toBe(2);
    expect(registry.truncated).toBe(true);
  });
});
