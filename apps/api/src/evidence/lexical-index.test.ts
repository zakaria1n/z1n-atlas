import { describe, expect, it } from "vitest";
import { codeTokenizer, createLexicalIndex } from "./lexical-index";
import type { CodeGraph } from "@z1n/contracts";

const files = [
  {
    path: "src/auth/RegisterForm.tsx",
    content:
      "export function RegisterForm() {\n  return handleRegister({ email });\n}\nfunction handleRegister(input) {\n  return api.post('/api/auth/register', input);\n}",
  },
  {
    path: "server/repositories/user.ts",
    content:
      "export const create = (input) => {\n  return db.user.create({ data: input });\n}",
  },
];
const graph: CodeGraph = {
  nodes: [
    {
      id: "src/auth/RegisterForm.tsx",
      path: "src/auth/RegisterForm.tsx",
      exports: [],
    },
    {
      id: "src/auth/RegisterForm.tsx#1",
      path: "src/auth/RegisterForm.tsx",
      name: "RegisterForm",
      kind: "function",
      startLine: 1,
      endLine: 3,
      exports: [],
    },
    {
      id: "src/auth/RegisterForm.tsx#4",
      path: "src/auth/RegisterForm.tsx",
      name: "handleRegister",
      kind: "function",
      startLine: 4,
      endLine: 6,
      exports: [],
    },
    {
      id: "server/repositories/user.ts#1",
      path: "server/repositories/user.ts",
      name: "create",
      kind: "function",
      startLine: 1,
      endLine: 3,
      exports: [],
    },
  ],
  edges: [],
  evidence: [],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};

describe("indexed lexical retrieval", () => {
  it("splits camelCase and snake_case into searchable words", () => {
    expect(codeTokenizer("handleRegister")).toEqual(["handle", "register"]);
    expect(codeTokenizer("db.user.create({ data })")).toContain("user");
    expect(codeTokenizer("POST /api/auth/register")).toEqual([
      "post",
      "api",
      "auth",
      "register",
    ]);
  });
  it("reaches camelCase symbols from natural-language questions", () => {
    const index = createLexicalIndex(files, graph);
    const hits = index.search("How does user registration work?", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.some(
        (hit) => hit.name === "RegisterForm" || hit.name === "handleRegister",
      ),
    ).toBe(true);
  });
  it("reaches prose from identifier queries", () => {
    const index = createLexicalIndex(files, graph);
    const hits = index.search("RegisterForm", 5);
    expect(hits.length).toBeGreaterThan(0);
  });
  it("ranks the persistence write for a database question", () => {
    const index = createLexicalIndex(files, graph);
    const hits = index.search("How is the user saved to the database?", 3);
    expect(hits[0]?.path ?? "").toContain("user.ts");
  });
  it("returns no hits for questions without any term match", () => {
    const index = createLexicalIndex(files, graph);
    expect(index.search("quantumxyz fluxcapacitor")).toEqual([]);
  });
});
