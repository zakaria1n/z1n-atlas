import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeFiles } from "@z1n/analysis-core";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { runJourneyAgent } from "./journey-graph";
import { completePersistenceEvidence } from "../journey/complete-evidence";
import {
  createJourneyTools,
  type JourneyToolDefinition,
} from "../journey/tools";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/react-express-auth",
);
function loadFixture(dir: string) {
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
  walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
const files = loadFixture(fixtureDir);
const graph = await analyzeFiles(files);
const idOf = (name: string, pathPart?: string) => {
  const node = graph.nodes.find(
    (item) => item.name === name && (!pathPart || item.path.includes(pathPart)),
  );
  if (!node) throw new Error(`Fixture node "${name}" not found`);
  return node.id;
};
const kindId = (kind: string, name: string) => {
  const node = graph.nodes.find(
    (item) => item.kind === kind && item.name === name,
  );
  if (!node) throw new Error(`Fixture ${kind} "${name}" not found`);
  return node.id;
};
const step = (nodeId: string, text: string) => ({ nodeId, text });

type ScriptTurn =
  | { text: string; toolCalls?: undefined }
  | {
      toolCalls: { id: string; name: string; arguments: string }[];
      text?: undefined;
    }
  | { error: Error }
  | ((messages: BaseMessage[]) => ScriptTurn);

/**
 * Stands in for a provider integration: replays scripted turns (static or
 * computed from the conversation so far) and records what the journey graph
 * actually sent and bound. The bound clone shares state with the original,
 * so assertions read the same counters.
 */
class FakeChatModel extends BaseChatModel {
  shared = {
    calls: 0,
    seen: [] as BaseMessage[][],
    boundTools: [] as unknown[],
  };
  constructor(private readonly turns: ScriptTurn[]) {
    super({});
  }
  _llmType(): string {
    return "fake";
  }
  get calls(): number {
    return this.shared.calls;
  }
  get seen(): BaseMessage[][] {
    return this.shared.seen;
  }
  get boundTools(): unknown[] {
    return this.shared.boundTools;
  }
  override bindTools(tools: unknown[]): FakeChatModel {
    const bound = new FakeChatModel(this.turns);
    bound.shared = this.shared;
    bound.shared.boundTools = tools;
    return bound;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.shared.calls += 1;
    this.shared.seen.push(messages);
    const scripted = this.turns[this.shared.calls - 1];
    const turn = typeof scripted === "function" ? scripted(messages) : scripted;
    if (!turn) throw new Error("The scripted model ran out of turns.");
    if ("error" in turn && turn.error) throw turn.error;
    if (turn.toolCalls)
      return {
        generations: [
          {
            text: "",
            message: new AIMessage({
              content: "",
              tool_calls: turn.toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                args: JSON.parse(call.arguments) as Record<string, unknown>,
              })),
            }),
          },
        ],
      };
    const text = turn.text ?? "";
    return { generations: [{ text, message: new AIMessage(text) }] };
  }
}

const final = (steps: unknown[], uncertainties: string[] = []): ScriptTurn => ({
  text: JSON.stringify({ steps, uncertainties }),
});
const toolsTurn = (id: string, name: string, args: string): ScriptTurn => ({
  toolCalls: [{ id, name, arguments: args }],
});
const lastToolAnswer = (messages: BaseMessage[]): string => {
  const last = messages.at(-1);
  if (!(last instanceof ToolMessage))
    throw new Error("The scripted turn expected a tool answer.");
  return String(last.content);
};

describe("AI-guided journey graph", () => {
  it("returns a bounded source page with a continuation instead of discarding long excerpts", () => {
    const longFiles = [
      {
        path: "long.ts",
        content: Array.from({ length: 40 }, () => "x".repeat(300)).join("\n"),
      },
    ];
    const emptyGraph = {
      nodes: [],
      edges: [],
      evidence: [],
      unresolved: 0,
      unresolvedCalls: 0,
      notice: "",
    };
    const tools = createJourneyTools(longFiles, emptyGraph);
    const page = JSON.parse(
      tools.execute({
        name: "read_file",
        arguments: '{"path":"long.ts","startLine":1,"endLine":40}',
      }).output,
    );
    expect(page.lines.length).toBeGreaterThan(0);
    expect(page.nextLine).toBe(page.lines.length + 1);
    expect(page.truncated).toBe(true);
  });
  it("allows a bounded second correction when a model returns prose twice", async () => {
    const model = new FakeChatModel([
      { text: "I will inspect the code." },
      { text: "I need one more lookup." },
      final([], ["Insufficient evidence."]),
    ]);
    const journey = await runJourneyAgent({
      question: "Find an unknown feature",
      files,
      graph,
      model,
    });
    expect(model.calls).toBe(3);
    expect(journey.uncertainties).toEqual(["Insufficient evidence."]);
  });
  it("paginates routes and reports an empty search without claiming feature absence", () => {
    const route = graph.nodes.find((node) => node.kind === "route")!;
    const expanded = {
      ...graph,
      nodes: [
        ...graph.nodes,
        ...Array.from({ length: 8 }, (_, index) => ({
          ...route,
          id: `${route.path}#extra-route-${index}`,
          name: `GET /extra/${index}`,
        })),
      ],
    };
    const tools = createJourneyTools(files, expanded);
    const first = JSON.parse(
      tools.execute({ name: "find_routes", arguments: "{}" }).output,
    );
    expect(first.routes).toHaveLength(5);
    expect(first.nextOffset).toBe(5);
    const second = JSON.parse(
      tools.execute({ name: "find_routes", arguments: '{"offset":5}' }).output,
    );
    expect(second.routes.length).toBeGreaterThan(0);
    expect(
      second.routes.every(
        (item: { nodeId: string }) =>
          !first.routes.some(
            (prior: { nodeId: string }) => prior.nodeId === item.nodeId,
          ),
      ),
    ).toBe(true);
    const empty = JSON.parse(
      tools.execute({
        name: "find_routes",
        arguments: '{"path":"unlikely-route-name"}',
      }).output,
    );
    expect(empty.routes).toEqual([]);
    expect(empty.total).toBe(0);
    const result = JSON.parse(
      tools.execute({
        name: "discover_feature",
        arguments: '{"query":"register"}',
      }).output,
    );
    expect(result.scope).toContain("do not prove");
    expect(result.candidates.length).toBeGreaterThan(0);
  });
  it("does not choose between ambiguous writes without a selected operation", async () => {
    const pythonFiles = loadFixture(
      path.resolve(fixtureDir, "../fastapi-booking"),
    );
    const pythonGraph = await analyzeFiles(pythonFiles);
    const owner = pythonGraph.nodes.find(
      (node) => node.name === "create_booking" && node.kind === "function",
    )!;
    const write = pythonGraph.edges.find(
      (edge) =>
        edge.source === owner.id &&
        pythonGraph.nodes.find((node) => node.id === edge.target)?.name ===
          "SQLAlchemy write add Booking",
    )!;
    const original = pythonGraph.nodes.find(
      (node) => node.id === write.target,
    )!;
    const ambiguous = {
      ...pythonGraph,
      nodes: [
        ...pythonGraph.nodes,
        { ...original, id: "other-write", name: "SQLAlchemy write add Other" },
      ],
      edges: [
        ...pythonGraph.edges,
        { ...write, id: "other-edge", target: "other-write" },
      ],
    };
    const result = completePersistenceEvidence(
      {
        mode: "ai",
        nodeIds: [owner.id],
        edgeIds: [],
        uncertainties: ["Static analysis."],
      },
      ambiguous,
      "Save booking in database",
    );
    expect(result.relatedOperations ?? []).toEqual([]);
  });
  it("recovers transaction evidence for an identified Python write without treating rollback as executed", async () => {
    const pythonFiles = loadFixture(
      path.resolve(fixtureDir, "../fastapi-booking"),
    );
    const pythonGraph = await analyzeFiles(pythonFiles);
    const owner = pythonGraph.nodes.find(
      (node) => node.name === "create_booking" && node.kind === "function",
    )!;
    const journey = await runJourneyAgent({
      question: "Where is the booking committed to the database?",
      files: pythonFiles,
      graph: pythonGraph,
      model: new FakeChatModel([
        final(
          [step(owner.id, "Creates a booking.")],
          ["No push mechanism exists in this repository."],
        ),
      ]),
    });
    const names = (journey.relatedOperations ?? []).map(
      (item) => pythonGraph.nodes.find((node) => node.id === item.nodeId)?.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "SQLAlchemy write add Booking",
        "SQLAlchemy flush",
        "SQLAlchemy rollback",
        "SQLAlchemy commit",
      ]),
    );
    expect(journey.uncertainties.join(" ")).toContain(
      "rollback may be conditional",
    );
    expect(journey.uncertainties.join(" ")).not.toContain(
      "No push mechanism exists",
    );
    expect(journey.edgeIds).toEqual([]);
  });
  it("retains a validated prefix when later proposed transitions remain invalid", async () => {
    const invalid = final([
      step(idOf("RegisterForm"), "Registration begins here."),
      step(idOf("loadSession"), "Unrelated."),
    ]);
    const journey = await runJourneyAgent({
      question: "How does registration work?",
      files,
      graph,
      model: new FakeChatModel([invalid, invalid]),
    });
    expect(journey.nodeIds).toEqual([idOf("RegisterForm")]);
    expect(journey.edgeIds).toEqual([]);
    expect(journey.uncertainties.join(" ")).toContain("partial path");
  });
  it("recognizes repeated tool calls without repeating the evidence response", async () => {
    const call = toolsTurn("s", "search_code", '{"query":"register"}');
    const model = new FakeChatModel([
      call,
      call,
      final([], ["No path was established."]),
    ]);
    await runJourneyAgent({
      question: "Find registration",
      files,
      graph,
      model,
    });
    const answers = model.seen
      .flat()
      .filter(
        (message): message is ToolMessage => message instanceof ToolMessage,
      )
      .map((message) => String(message.content));
    expect(answers).toContainEqual(
      expect.stringContaining("This tool call was already answered"),
    );
  });
  it("keeps transaction writes and conditional rollback as separately sourced Python operations", async () => {
    const pythonFiles = loadFixture(
      path.resolve(fixtureDir, "../fastapi-booking"),
    );
    const pythonGraph = await analyzeFiles(pythonFiles);
    let ownerRef = "";
    const model = new FakeChatModel([
      toolsTurn("s", "find_symbols", '{"query":"create_booking"}'),
      (messages) => {
        const result = JSON.parse(lastToolAnswer(messages));
        const fn = result.symbols.find(
          (item: { kind: string }) => item.kind === "function",
        );
        ownerRef = fn.ref;
        return toolsTurn(
          "n",
          "get_graph_neighbors",
          JSON.stringify({
            nodeId: ownerRef,
            relationship: "database-access",
          }),
        );
      },
      (messages) => {
        const result = JSON.parse(lastToolAnswer(messages));
        const operations = result.nodes.filter(
          (item: { kind: string }) => item.kind === "database",
        );
        return {
          text: JSON.stringify({
            steps: [
              {
                nodeId: ownerRef,
                text: "The booking handler contains transaction operations.",
              },
            ],
            relatedOperations: operations.map((item: { ref: string }) => ({
              ownerId: ownerRef,
              nodeId: item.ref,
            })),
            uncertainties: [
              "A static relationship does not prove that a branch executed.",
            ],
          }),
        };
      },
    ]);
    const journey = await runJourneyAgent({
      question: "Where is a booking persisted?",
      files: pythonFiles,
      graph: pythonGraph,
      model,
    });
    const names = (journey.relatedOperations ?? []).map(
      (item) => pythonGraph.nodes.find((node) => node.id === item.nodeId)?.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "SQLAlchemy write add Booking",
        "SQLAlchemy flush",
        "SQLAlchemy rollback",
        "SQLAlchemy commit",
      ]),
    );
    expect(journey.edgeIds).toEqual([]);
  });
  it("resolves issued references and keeps sibling database operations separate from the path", async () => {
    let ownerRef = "";
    const model = new FakeChatModel([
      toolsTurn("s", "find_symbols", '{"query":"create"}'),
      (messages) => {
        const result = JSON.parse(lastToolAnswer(messages));
        const fn = result.symbols.find((item: { path: string }) =>
          item.path.includes("repositories/user"),
        );
        ownerRef = fn.ref;
        return toolsTurn(
          "n",
          "get_graph_neighbors",
          JSON.stringify({ nodeId: ownerRef }),
        );
      },
      (messages) => {
        const result = JSON.parse(lastToolAnswer(messages));
        const database = result.nodes.find(
          (item: { kind: string }) => item.kind === "database",
        );
        return {
          text: JSON.stringify({
            steps: [{ nodeId: ownerRef, text: "Writes a user." }],
            relatedOperations: [{ ownerId: ownerRef, nodeId: database.ref }],
            uncertainties: ["Static evidence does not prove execution."],
          }),
        };
      },
    ]);
    const journey = await runJourneyAgent({
      question: "How is a user saved?",
      files,
      graph,
      model,
    });
    expect(journey.nodeIds).toEqual([idOf("create", "repositories/user")]);
    expect(journey.relatedOperations).toHaveLength(1);
    expect(journey.relatedOperations?.[0].nodeId).toBe(
      kindId("database", "Prisma user.create"),
    );
    expect(journey.edgeIds).toEqual([]);
  });
  it("requests a correction when the model returns malformed JSON", async () => {
    const model = new FakeChatModel([
      { text: '{"steps": [}' },
      final([], ["The feature could not be established."]),
    ]);
    const journey = await runJourneyAgent({
      question: "How does an unknown feature work?",
      files,
      graph,
      model,
    });
    expect(model.calls).toBe(2);
    expect(journey.nodeIds).toEqual([]);
    expect(journey.uncertainties[0]).toContain("could not be established");
  });
  it("explores with tools and reports a full-stack path backed by the graph", async () => {
    const model = new FakeChatModel([
      toolsTurn("t1", "search_code", '{"query":"register"}'),
      toolsTurn(
        "t2",
        "get_graph_neighbors",
        JSON.stringify({ nodeId: idOf("handleRegister") }),
      ),
      final(
        [
          step(idOf("RegisterForm"), "The registration form."),
          step(idOf("handleRegister"), "Submits the form."),
          step(
            kindId("http-call", "POST /api/auth/register"),
            "Sends the credentials.",
          ),
          step(
            kindId("route", "POST /api/auth/register"),
            "Backend route that receives them.",
          ),
          step(idOf("register"), "Controller for registration."),
          step(idOf("create", "services/user"), "Creates the account."),
          step(idOf("create", "repositories/user"), "Writes the row."),
          step(kindId("database", "Prisma user.create"), "Stores the user."),
        ],
        ["The route match is heuristic."],
      ),
    ]);
    const journey = await runJourneyAgent({
      question: "How does user registration work?",
      files,
      graph,
      model,
    });
    expect(journey.mode).toBe("ai");
    expect(journey.nodeIds[0]).toBe(idOf("RegisterForm"));
    expect(journey.nodeIds[1]).toBe(idOf("handleRegister"));
    expect(journey.nodeIds[journey.nodeIds.length - 1]).toBe(
      kindId("database", "Prisma user.create"),
    );
    expect(journey.edgeIds).toHaveLength(journey.nodeIds.length - 1);
    expect(journey.explanations?.[0]).toEqual({
      nodeId: idOf("RegisterForm"),
      text: "The registration form.",
      // Every explanation gains a backend-computed support classification;
      // this step's first transition is the framework handles-event edge.
      support: {
        level: "relationship",
        edgeIds: [journey.edgeIds[0]],
      },
    });
    expect(
      journey.explanations?.every((explanation) => explanation.support),
    ).toBe(true);
    expect(
      journey.uncertainties.some((note) => note.includes("heuristic")),
    ).toBe(true);
    expect(model.calls).toBe(3);
    // The bound definitions cover exactly the read-only tool surface.
    expect(
      (model.boundTools as JourneyToolDefinition[]).map((tool) => tool.name),
    ).toEqual([
      "discover_feature",
      "find_symbols",
      "search_code",
      "read_file",
      "get_graph_neighbors",
      "find_routes",
    ]);
    // The final round's context must contain the relationship lookup answer.
    expect(JSON.stringify(model.seen.at(-1)).includes("handles-event")).toBe(
      true,
    );
  });
  it("follows a different feature without registration-specific handling", async () => {
    const journey = await runJourneyAgent({
      question: "How does refreshing a session work?",
      files,
      graph,
      model: new FakeChatModel([
        toolsTurn("t1", "find_routes", '{"path":"session"}'),
        final([
          step(idOf("SessionStatus"), "Shows the current session."),
          step(idOf("handleRefresh"), "Asks for a refresh."),
          step(
            kindId("http-call", "GET /api/auth/session"),
            "Requests the session.",
          ),
          step(kindId("route", "GET /api/auth/session"), "Session endpoint."),
          step(
            idOf("GET /api/auth/session handler"),
            "Inline handler of the route.",
          ),
          step(idOf("loadSession"), "Loads the stored session."),
          step(
            kindId("database", "Prisma session.findUnique"),
            "Reads the session row.",
          ),
        ]),
      ]),
    });
    expect(journey.mode).toBe("ai");
    expect(journey.nodeIds).toEqual([
      idOf("SessionStatus"),
      idOf("handleRefresh"),
      kindId("http-call", "GET /api/auth/session"),
      kindId("route", "GET /api/auth/session"),
      idOf("GET /api/auth/session handler"),
      idOf("loadSession"),
      kindId("database", "Prisma session.findUnique"),
    ]);
  });
  it("rejects invented identifiers and recovers after a correction", async () => {
    const model = new FakeChatModel([
      final([step("component/Invented.tsx#1", "Made up.")]),
      final([step(idOf("RegisterForm"), "Entry form.")]),
    ]);
    const journey = await runJourneyAgent({
      question: "Where does registration start?",
      files,
      graph,
      model,
    });
    const corrections = model.seen
      .flat()
      .filter(
        (message): message is HumanMessage => message instanceof HumanMessage,
      )
      .map((message) => String(message.content));
    expect(corrections.join(" ")).toContain("not a node of this graph");
    expect(model.calls).toBe(2);
    expect(journey.mode).toBe("ai");
    expect(journey.nodeIds).toEqual([idOf("RegisterForm")]);
    expect(journey.edgeIds).toEqual([]);
    expect(
      journey.uncertainties.some((note) =>
        note.includes("No supported transition"),
      ),
    ).toBe(true);
  });
  it("rejects steps that the graph does not connect and can report no journey", async () => {
    const model = new FakeChatModel([
      final([
        step(idOf("RegisterForm"), "Form."),
        step(idOf("loadSession"), "Unrelated session loader."),
      ]),
      final([], ["No analyzed code connects the checkout question."]),
    ]);
    const journey = await runJourneyAgent({
      question: "How does checkout work?",
      files,
      graph,
      model,
    });
    expect(model.calls).toBe(2);
    expect(journey.mode).toBe("ai");
    expect(journey.nodeIds).toEqual([]);
    expect(journey.uncertainties[0]).toContain(
      "No analyzed code connects the checkout question.",
    );
  });
  it("stops the exploration at the tool budget", async () => {
    const model = new FakeChatModel(
      Array.from({ length: 10 }, (_, index) =>
        toolsTurn(`t${index}`, "search_code", '{"query":"register"}'),
      ),
    );
    const journey = await runJourneyAgent({
      question: "How does registration work?",
      files,
      graph,
      model,
    });
    expect(model.calls).toBe(6);
    expect(journey.mode).toBe("ai");
    expect(journey.nodeIds).toEqual([]);
    expect(journey.uncertainties[0]).toContain("without a validated path");
  });
  it("reports a provider that fails instead of showing a static path", async () => {
    const journey = await runJourneyAgent({
      question: "How does registration work?",
      files,
      graph,
      model: new FakeChatModel([{ error: new Error("boom") }]),
    });
    expect(journey.mode).toBe("ai");
    expect(journey.nodeIds).toEqual([]);
    expect(journey.uncertainties[0]).toContain("AI provider");
  });
  it("opens every exploration with the system instructions and the question", async () => {
    const model = new FakeChatModel([final([], ["Nothing found."])]);
    await runJourneyAgent({
      question: "How does login work?",
      files,
      graph,
      model,
    });
    expect(model.seen[0][0]).toBeInstanceOf(SystemMessage);
    expect(String((model.seen[0][0] as SystemMessage).content)).toContain(
      "discover_feature",
    );
    expect(model.seen[0][1]).toBeInstanceOf(HumanMessage);
    expect(String((model.seen[0][1] as HumanMessage).content)).toBe(
      "How does login work?",
    );
  });
});
