import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { CodeGraph } from "@z1n/contracts";
import { analyzeFiles } from "@z1n/analysis-core";
import { answerQuestion, type AnswerContext } from "./answer";
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

describe("chat evidence retrieval quality", () => {
  const fixtureDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../fixtures/fastapi-booking",
  );
  function loadFixture(): { path: string; content: string }[] {
    const files: { path: string; content: string }[] = [];
    const walk = (current: string, prefix = "") => {
      for (const entry of readdirSync(current)) {
        const absolute = path.join(current, entry);
        const relative = prefix ? `${prefix}/${entry}` : entry;
        if (statSync(absolute).isDirectory()) walk(absolute, relative);
        else
          files.push({
            path: relative,
            content: readFileSync(absolute, "utf8"),
          });
      }
    };
    walk(fixtureDir);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  async function setup() {
    const files = loadFixture();
    const graph = await analyzeFiles(files);
    return { files, graph };
  }

  it("seeds ranked symbol and route candidates for general questions", async () => {
    const { files, graph } = await setup();
    const contexts: AnswerContext[] = [];
    const answer = await answerQuestion(
      "What does this application do?",
      files,
      graph,
      async (context) => {
        contexts.push(context);
        return {
          claims: [
            {
              text: "It books facility reservations.",
              evidenceIds: [context.evidence[0].id],
            },
          ],
          uncertainties: [],
        };
      },
    );
    expect(contexts.length).toBe(1);
    // A general question must still receive concrete code anchors, not only
    // raw string matches: ranked symbols and routes are seeded as evidence.
    const seeded = contexts[0].evidence.filter((item) =>
      item.id.startsWith("node:"),
    );
    expect(seeded.length).toBeGreaterThan(0);
    expect(answer.claims.length).toBe(1);
  }, 30_000);

  it("routes keyword questions toward the matching source and nodes", async () => {
    const { files, graph } = await setup();
    const contexts: AnswerContext[] = [];
    await answerQuestion(
      "How is a booking committed to the database?",
      files,
      graph,
      async (context) => {
        contexts.push(context);
        return { claims: [], uncertainties: ["insufficient"] };
      },
    );
    const citations = contexts[0].evidence;
    // Keyword retrieval finds the booking source; discovery seeds the
    // commit transaction-boundary node that string search alone misses.
    expect(
      citations.some(
        (item) =>
          item.filePath === "backend/app/bookings.py" &&
          /booking/i.test(item.snippet),
      ),
    ).toBe(true);
    expect(
      citations.some(
        (item) =>
          item.id.startsWith("node:") && /commit/i.test(item.snippet ?? ""),
      ),
    ).toBe(true);
  }, 30_000);

  it("reports honest emptiness for questions nothing matches", async () => {
    const { files, graph } = await setup();
    const answer = await answerQuestion(
      "quantumxyz fluxcapacitor calibration",
      files,
      graph,
      async () => {
        throw new Error("The model must not be called without evidence.");
      },
    );
    expect(answer.claims).toEqual([]);
    expect(answer.uncertainties[0]).toContain("No matching evidence");
  }, 30_000);
});
