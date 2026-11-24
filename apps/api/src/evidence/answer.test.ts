import { describe, expect, it, vi } from "vitest";
import type { CodeGraph } from "@z1n/contracts";
import { answerQuestion } from "./answer";
const files = [
  {
    path: "src/login.ts",
    content: "export function login() {\n  return fetch('/login');\n}",
  },
];
const graph: CodeGraph = {
  nodes: [{ id: "src/login.ts", path: "src/login.ts", exports: [] }],
  edges: [],
  evidence: [],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};
describe("grounded answer validation", () => {
  it("returns only supplied source citations and keeps repository content untrusted", async () => {
    const generate = vi.fn(
      async ({
        evidence,
        system,
      }: {
        evidence: { id: string }[];
        system: string;
      }) => {
        expect(system).toContain("untrusted data");
        return {
          claims: [
            {
              text: "The login function sends a request.",
              evidenceIds: [evidence[0].id],
            },
          ],
          uncertainties: [],
        };
      },
    );
    const answer = await answerQuestion(
      "Where is login?",
      files,
      graph,
      generate,
    );
    expect(answer.claims[0].citations[0]).toMatchObject({
      filePath: "src/login.ts",
      startLine: 1,
    });
  });
  it("drops unsupported claims and does not invent citations", async () => {
    const answer = await answerQuestion(
      "Where is login?",
      files,
      graph,
      async () => ({
        claims: [
          { text: "Fabricated", evidenceIds: ["invented"] },
          { text: "Missing", evidenceIds: [] },
        ],
        uncertainties: [],
      }),
    );
    expect(answer.claims).toEqual([]);
    expect(answer.uncertainties.join()).toContain("omitted");
  });
  it("abstains without matching source and rejects malformed output", async () => {
    const generate = vi.fn(async () => ({ bad: true }));
    const absent = await answerQuestion(
      "Where is payment?",
      files,
      graph,
      generate,
    );
    expect(generate).not.toHaveBeenCalled();
    expect(absent.claims).toEqual([]);
    const malformed = await answerQuestion(
      "Where is login?",
      files,
      graph,
      generate,
    );
    expect(malformed.claims).toEqual([]);
    expect(malformed.uncertainties.join()).toContain("could not be validated");
  });
});
