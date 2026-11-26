import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { CodeGraph } from "@z1n/contracts";
import { analyzeFiles } from "@z1n/analysis-core";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { answerWithGraph } from "../orchestration/chat-graph";
import type { ToolCallingModel } from "../orchestration/chat-model";

const files = [
  {
    path: "src/login.ts",
    content:
      "export function login() {\n  return fetch('/login');\n}\n\nfunction sendRequest(url: string) {\n  return fetch(url);\n}",
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

type AnswerScript =
  | { toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }
  | Record<string, unknown>
  | Error
  | ((calls: number) => Record<string, unknown> | Error);

/**
 * A scripted chat model: replays final JSON texts or tool-call turns and
 * records what the graph sent and bound. The bound clone shares state with
 * the original so assertions read the same counters.
 */
class ScriptedChatModel implements ToolCallingModel {
  shared = { calls: [] as BaseMessage[][], boundTools: [] as unknown[] };
  constructor(private readonly answers: AnswerScript[]) {}
  bindTools(tools: unknown[]): ToolCallingModel {
    const bound = new ScriptedChatModel(this.answers);
    bound.shared = this.shared;
    bound.shared.boundTools = tools;
    return bound;
  }
  get calls(): BaseMessage[][] {
    return this.shared.calls;
  }
  get boundTools(): unknown[] {
    return this.shared.boundTools;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.shared.calls.push(messages);
    const scripted = this.answers[this.shared.calls.length - 1];
    const answer =
      typeof scripted === "function"
        ? scripted(this.shared.calls.length)
        : scripted;
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error("The scripted chat model ran out of answers.");
    if ("toolCalls" in answer)
      return new AIMessage({
        content: "",
        tool_calls: answer.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          args: call.args,
        })),
      });
    return new AIMessage(JSON.stringify(answer));
  }
  request(calls: number): {
    question: string;
    evidence: { id: string }[];
    history: unknown[];
  } {
    const [, user] = this.calls[calls - 1];
    return JSON.parse(String((user as HumanMessage).content));
  }
}

describe("grounded answer validation on the chat graph", () => {
  it("returns only supplied source citations and keeps repository content untrusted", async () => {
    const model = new ScriptedChatModel([
      (calls) => {
        const request = model.request(calls);
        return {
          claims: [
            {
              text: "The login function sends a request.",
              evidenceIds: [request.evidence[0].id],
            },
          ],
          uncertainties: [],
        };
      },
    ]);
    const answer = await answerWithGraph({
      question: "Where is login?",
      files,
      graph,
      model,
    });
    expect(answer.claims[0].citations[0]).toMatchObject({
      filePath: "src/login.ts",
      startLine: 1,
    });
    const [system] = model.calls[0];
    expect(system).toBeInstanceOf(SystemMessage);
    expect(String(system.content)).toContain("untrusted data");
    // The graph binds the shared read-only tools for deeper exploration.
    expect(model.boundTools.length).toBeGreaterThan(0);
  });
  it("drops unsupported claims and does not invent citations", async () => {
    const answer = await answerWithGraph({
      question: "Where is login?",
      files,
      graph,
      model: new ScriptedChatModel([
        {
          claims: [
            { text: "Fabricated", evidenceIds: ["invented"] },
            { text: "Missing", evidenceIds: [] },
          ],
          uncertainties: [],
        },
      ]),
    });
    expect(answer.claims).toEqual([]);
    expect(answer.uncertainties.join()).toContain("omitted");
  });
  it("abstains without matching source and rejects malformed output", async () => {
    const absentModel = new ScriptedChatModel([
      () => {
        throw new Error("The model must not be called without evidence.");
      },
    ]);
    const absent = await answerWithGraph({
      question: "Where is payment?",
      files,
      graph,
      model: absentModel,
    });
    expect(absentModel.calls.length).toBe(0);
    expect(absent.claims).toEqual([]);
    expect(absent.uncertainties[0]).toContain("No matching evidence");
    const malformed = await answerWithGraph({
      question: "Where is login?",
      files,
      graph,
      model: new ScriptedChatModel([{ bad: true }, { bad: true }]),
    });
    expect(malformed.claims).toEqual([]);
    expect(malformed.uncertainties.join()).toContain("could not be validated");
  });
  it("accepts evidence the model retrieved itself through the shared tools", async () => {
    const model = new ScriptedChatModel([
      {
        toolCalls: [
          { id: "t1", name: "search_code", args: { query: "sendRequest" } },
        ],
      },
      {
        claims: [
          {
            text: "The login flow delegates to sendRequest, which fetches the URL.",
            evidenceIds: ["source:src/login.ts:5"],
          },
        ],
        uncertainties: [],
      },
    ]);
    const answer = await answerWithGraph({
      question: "Where is login?",
      files,
      graph,
      model,
    });
    // Line 5 was never part of the initial retrieval: the citation validates
    // only because the search_code tool result registered it.
    expect(answer.claims[0].citations[0]).toMatchObject({
      filePath: "src/login.ts",
      startLine: 5,
    });
    const toolAnswer = model.calls[1].at(-1);
    expect(toolAnswer).toBeInstanceOf(ToolMessage);
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
    const model = new ScriptedChatModel([
      (calls) => ({
        claims: [
          {
            text: "Cited from supplied evidence.",
            evidenceIds: [model.request(calls).evidence[0].id],
          },
        ],
        uncertainties: [],
      }),
    ]);
    const answer = await answerWithGraph({
      question: "What does this application do?",
      files,
      graph,
      model,
    });
    // A general question must still receive concrete code anchors, not only
    // raw string matches: ranked symbols and routes are seeded as evidence.
    const seeded = model
      .request(1)
      .evidence.filter((item) => item.id.startsWith("node:"));
    expect(seeded.length).toBeGreaterThan(0);
    expect(answer.claims.length).toBe(1);
    expect(model.calls.length).toBe(1);
  }, 30_000);

  it("routes keyword questions toward the matching source and nodes", async () => {
    const { files, graph } = await setup();
    const model = new ScriptedChatModel([
      (calls) => ({
        claims: [
          {
            text: "Cited from supplied evidence.",
            evidenceIds: [model.request(calls).evidence[0].id],
          },
        ],
        uncertainties: [],
      }),
    ]);
    await answerWithGraph({
      question: "How is a booking committed to the database?",
      files,
      graph,
      model,
    });
    const citations = model.request(1).evidence;
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
    const model = new ScriptedChatModel([
      () => {
        throw new Error("The model must not be called without evidence.");
      },
    ]);
    const answer = await answerWithGraph({
      question: "quantumxyz fluxcapacitor calibration",
      files,
      graph,
      model,
    });
    expect(model.calls.length).toBe(0);
    expect(answer.claims).toEqual([]);
    expect(answer.uncertainties[0]).toContain("No matching evidence");
  }, 30_000);
});
