import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeFiles } from "@z1n/analysis-core";
import { runJourneyAgent, type AgentGenerate, type AgentTurn } from "./agent";
import { completePersistenceEvidence } from "./complete-evidence";

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
const final = (steps: unknown, uncertainties: string[] = []): AgentTurn => ({
  kind: "final",
  text: JSON.stringify({ steps, uncertainties }),
});
function scripted(
  turns: AgentTurn[],
  onCall?: (context: {
    round: number;
    messages: unknown[];
    tools: { name: string }[];
  }) => void,
): AgentGenerate & { calls: number } {
  const state = { round: 0 };
  const generate = async (input: Parameters<AgentGenerate>[0]) => {
    onCall?.({
      round: state.round,
      messages: input.messages,
      tools: input.tools.map((tool) => ({ name: tool.name })),
    });
    const turn = turns[state.round];
    state.round += 1;
    if (!turn) throw new Error("The scripted provider ran out of turns.");
    return turn;
  };
  return Object.defineProperty(generate, "calls", {
    get: () => state.round,
  });
}

describe("AI-guided journey agent", () => {
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
    const graph = {
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
      graph,
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
    const generate = scripted([
      final(
        [step(owner.id, "Creates a booking.")],
        ["No push mechanism exists in this repository."],
      ),
    ]);
    const journey = await runJourneyAgent({
      question: "Where is the booking committed to the database?",
      files: pythonFiles,
      graph: pythonGraph,
      generate,
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
      generate: scripted([invalid, invalid]),
    });
    expect(journey.nodeIds).toEqual([idOf("RegisterForm")]);
    expect(journey.edgeIds).toEqual([]);
    expect(journey.uncertainties.join(" ")).toContain("partial path");
  });
  it("recognizes repeated tool calls without repeating the evidence response", async () => {
    let messages: unknown[] = [];
    const call: AgentTurn = {
      kind: "tools",
      toolCalls: [
        { id: "s", name: "search_code", arguments: '{"query":"register"}' },
      ],
    };
    const generate = scripted(
      [call, call, final([], ["No path was established."])],
      (context) => {
        messages = context.messages;
      },
    );
    await runJourneyAgent({
      question: "Find registration",
      files,
      graph,
      generate,
    });
    expect(JSON.stringify(messages)).toContain(
      "This tool call was already answered",
    );
  });
  it("keeps transaction writes and conditional rollback as separately sourced Python operations", async () => {
    const pythonFiles = loadFixture(
      path.resolve(fixtureDir, "../fastapi-booking"),
    );
    const pythonGraph = await analyzeFiles(pythonFiles);
    let ownerRef = "";
    let round = 0;
    const generate: AgentGenerate = async ({ messages }) => {
      round++;
      if (round === 1)
        return {
          kind: "tools",
          toolCalls: [
            {
              id: "s",
              name: "find_symbols",
              arguments: '{"query":"create_booking"}',
            },
          ],
        };
      if (round === 2) {
        const result = JSON.parse(
          (messages.at(-1) as { content: string }).content,
        );
        ownerRef = result.symbols.find(
          (item: { kind: string }) => item.kind === "function",
        ).ref;
        return {
          kind: "tools",
          toolCalls: [
            {
              id: "n",
              name: "get_graph_neighbors",
              arguments: JSON.stringify({
                nodeId: ownerRef,
                relationship: "database-access",
              }),
            },
          ],
        };
      }
      const result = JSON.parse(
        (messages.at(-1) as { content: string }).content,
      );
      const operations = result.nodes.filter(
        (item: { kind: string }) => item.kind === "database",
      );
      return {
        kind: "final",
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
    };
    const journey = await runJourneyAgent({
      question: "Where is a booking persisted?",
      files: pythonFiles,
      graph: pythonGraph,
      generate,
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
    let round = 0;
    let ownerRef = "";
    const generate: AgentGenerate = async ({ messages }) => {
      round++;
      if (round === 1)
        return {
          kind: "tools",
          toolCalls: [
            { id: "s", name: "find_symbols", arguments: '{"query":"create"}' },
          ],
        };
      if (round === 2) {
        const result = JSON.parse(
          (messages.at(-1) as { content: string }).content,
        );
        ownerRef = result.symbols.find((item: { path: string }) =>
          item.path.includes("repositories/user"),
        ).ref;
        return {
          kind: "tools",
          toolCalls: [
            {
              id: "n",
              name: "get_graph_neighbors",
              arguments: JSON.stringify({ nodeId: ownerRef }),
            },
          ],
        };
      }
      const result = JSON.parse(
        (messages.at(-1) as { content: string }).content,
      );
      const database = result.nodes.find(
        (item: { kind: string }) => item.kind === "database",
      );
      return {
        kind: "final",
        text: JSON.stringify({
          steps: [{ nodeId: ownerRef, text: "Writes a user." }],
          relatedOperations: [{ ownerId: ownerRef, nodeId: database.ref }],
          uncertainties: ["Static evidence does not prove execution."],
        }),
      };
    };
    const journey = await runJourneyAgent({
      question: "How is a user saved?",
      files,
      graph,
      generate,
    });
    expect(journey.nodeIds).toEqual([idOf("create", "repositories/user")]);
    expect(journey.relatedOperations).toHaveLength(1);
    expect(journey.relatedOperations?.[0].nodeId).toBe(
      kindId("database", "Prisma user.create"),
    );
    expect(journey.edgeIds).toEqual([]);
  });
  it("requests a correction when the model returns malformed JSON", async () => {
    const generate = scripted([
      { kind: "final", text: '{"steps": [}' },
      final([], ["The feature could not be established."]),
    ]);
    const journey = await runJourneyAgent({
      question: "How does an unknown feature work?",
      files,
      graph,
      generate,
    });
    expect(generate.calls).toBe(2);
    expect(journey.nodeIds).toEqual([]);
    expect(journey.uncertainties[0]).toContain("could not be established");
  });
  it("explores with tools and reports a full-stack path backed by the graph", async () => {
    const seen: {
      tools: { name: string }[];
      messages: unknown[];
    }[] = [];
    const generate = scripted(
      [
        {
          kind: "tools",
          toolCalls: [
            {
              id: "t1",
              name: "search_code",
              arguments: '{"query":"register"}',
            },
          ],
        },
        {
          kind: "tools",
          toolCalls: [
            {
              id: "t2",
              name: "get_graph_neighbors",
              arguments: JSON.stringify({ nodeId: idOf("handleRegister") }),
            },
          ],
        },
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
      ],
      (context) =>
        seen.push({ tools: context.tools, messages: context.messages }),
    );
    const journey = await runJourneyAgent({
      question: "How does user registration work?",
      files,
      graph,
      generate,
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
    });
    expect(
      journey.uncertainties.some((note) => note.includes("heuristic")),
    ).toBe(true);
    expect(generate.calls).toBe(3);
    expect(seen[0].tools.map((tool) => tool.name)).toEqual([
      "find_symbols",
      "search_code",
      "read_file",
      "get_graph_neighbors",
      "find_routes",
    ]);
    // The final round's context must contain the relationship lookup answer.
    expect(JSON.stringify(seen[2].messages).includes("handles-event")).toBe(
      true,
    );
  });
  it("follows a different feature without registration-specific handling", async () => {
    const generate = scripted([
      {
        kind: "tools",
        toolCalls: [
          { id: "t1", name: "find_routes", arguments: '{"path":"session"}' },
        ],
      },
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
    ]);
    const journey = await runJourneyAgent({
      question: "How does refreshing a session work?",
      files,
      graph,
      generate,
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
    let corrective = "";
    const generate = scripted(
      [
        final([step("component/Invented.tsx#1", "Made up.")]),
        final([step(idOf("RegisterForm"), "Entry form.")]),
      ],
      (context) => {
        const last = context.messages[context.messages.length - 1] as
          { role: string; text?: string } | undefined;
        if (last?.role === "user") corrective = last.text ?? "";
      },
    );
    const journey = await runJourneyAgent({
      question: "Where does registration start?",
      files,
      graph,
      generate,
    });
    expect(corrective).toContain("not a node of this graph");
    expect(generate.calls).toBe(2);
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
    const generate = scripted([
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
      generate,
    });
    expect(generate.calls).toBe(2);
    expect(journey.mode).toBe("ai");
    expect(journey.nodeIds).toEqual([]);
    expect(journey.uncertainties[0]).toContain(
      "No analyzed code connects the checkout question.",
    );
  });
  it("stops the exploration at the tool budget", async () => {
    const generate = scripted(
      Array.from({ length: 10 }, (_, index) => ({
        kind: "tools" as const,
        toolCalls: [
          {
            id: `t${index}`,
            name: "search_code",
            arguments: '{"query":"register"}',
          },
        ],
      })),
    );
    const journey = await runJourneyAgent({
      question: "How does registration work?",
      files,
      graph,
      generate,
    });
    expect(generate.calls).toBe(6);
    expect(journey.mode).toBe("ai");
    expect(journey.nodeIds).toEqual([]);
    expect(journey.uncertainties[0]).toContain("without a validated path");
  });
  it("reports a provider that fails instead of showing a static path", async () => {
    const generate = async () => {
      throw new Error("boom");
    };
    const journey = await runJourneyAgent({
      question: "How does registration work?",
      files,
      graph,
      generate,
    });
    expect(journey.mode).toBe("ai");
    expect(journey.nodeIds).toEqual([]);
    expect(journey.uncertainties[0]).toContain("AI provider");
  });
});
