import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeFiles } from "@z1n/analysis-core";
import { journeyIsValid, type CodeGraph } from "@z1n/contracts";
import { groundExplanations } from "./claims";

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

async function bookingGraph(): Promise<{
  graph: CodeGraph;
  files: { path: string; content: string }[];
  ids: Record<string, string>;
}> {
  const files = loadFixture();
  const graph = await analyzeFiles(files);
  const idOf = (name: string, kind?: string) =>
    graph.nodes.find(
      (node) => node.name === name && (!kind || node.kind === kind),
    )!.id;
  return {
    graph,
    files,
    ids: {
      route: idOf("POST /api/bookings", "route"),
      create: idOf("create_booking"),
      read: idOf("read_booking"),
      add: idOf("SQLAlchemy write add Booking", "database"),
      commit: idOf("SQLAlchemy commit", "database"),
      model: idOf("Booking", "class"),
    },
  };
}

function journey(
  graph: CodeGraph,
  nodeIds: string[],
  explanations: {
    nodeId: string;
    text: string;
  }[],
) {
  const edgeIds: string[] = [];
  for (let index = 0; index < nodeIds.length - 1; index++) {
    const edge = graph.edges.find(
      (candidate) =>
        candidate.source === nodeIds[index] &&
        candidate.target === nodeIds[index + 1],
    );
    if (edge) edgeIds.push(edge.id);
  }
  return {
    mode: "ai" as const,
    nodeIds,
    edgeIds,
    uncertainties: ["Baseline."],
    explanations,
  };
}

describe("claim-level evidence grounding", () => {
  it("qualifies an explanation of confirmed behavior behind a heuristic match", async () => {
    const { graph, files, ids } = await bookingGraph();
    // A client-side explanation whose incoming transition is the heuristic
    // http-route match: any confirmed wording must be qualified in place.
    const client = graph.nodes.find((node) => node.kind === "http-call")!.id;
    const grounded = groundExplanations(
      journey(
        graph,
        [client, ids.route, ids.create, ids.add],
        [
          {
            nodeId: ids.route,
            text: "This endpoint is confirmed to receive the booking submission at runtime.",
          },
        ],
      ),
      graph,
      files,
    );
    const support = grounded.explanations?.[0].support;
    expect(support?.level).toBe("heuristic");
    expect(support?.note).toContain("heuristic URL and method match");
  }, 30_000);

  it("qualifies proven-runtime wording behind a framework-derived edge", async () => {
    const { graph, files, ids } = await bookingGraph();
    const grounded = groundExplanations(
      journey(
        graph,
        [ids.route, ids.create],
        [
          {
            nodeId: ids.create,
            text: "FastAPI has proven to execute this handler for every matching request.",
          },
        ],
      ),
      graph,
      files,
    );
    const explanation = grounded.explanations?.[0];
    expect(explanation?.text).toContain(
      "[Static analysis — not runtime-verified]",
    );
    expect(explanation?.support?.level).toBe("relationship");
  }, 30_000);

  it("marks a statement whose citation is absent from the file as inference", async () => {
    const { graph, files, ids } = await bookingGraph();
    const grounded = groundExplanations(
      journey(
        graph,
        [ids.create],
        [
          {
            nodeId: ids.create,
            text: "The handler stores rows through `bookingRepository.persistRow` and returns at `scale(9000)`.",
          },
        ],
      ),
      graph,
      files,
    );
    const support = grounded.explanations?.[0].support;
    expect(support?.level).toBe("inference");
    expect(support?.note).toContain("treat it as the model's interpretation");
    expect(support?.sourceRefs).toBeUndefined();
  }, 30_000);

  it("verifies a valid source-backed statement with exact line references", async () => {
    const { graph, files, ids } = await bookingGraph();
    const grounded = groundExplanations(
      journey(
        graph,
        [ids.create],
        [
          {
            nodeId: ids.create,
            text: "The handler calls `db.add(booking)` and then `db.commit()`.",
          },
        ],
      ),
      graph,
      files,
    );
    const support = grounded.explanations?.[0].support;
    expect(support?.level).toBe("source");
    expect(support?.sourceRefs?.length).toBeGreaterThan(0);
    for (const reference of support?.sourceRefs ?? []) {
      expect(reference.path).toBe("backend/app/bookings.py");
      const file = files.find((item) => item.path === reference.path)!;
      const lines = file.content.split(/\r\n|\r|\n/);
      expect(
        lines
          .slice(reference.startLine - 1, reference.endLine)
          .join("\n")
          .includes(reference.fragment),
      ).toBe(true);
    }
  }, 30_000);

  it("does not verify a fragment that only exists in a different file", async () => {
    const { graph, files, ids } = await bookingGraph();
    // `compute_total(` lives in services.py; an explanation citing it on the
    // models step must not be labeled source.
    const grounded = groundExplanations(
      journey(
        graph,
        [ids.model],
        [
          {
            nodeId: ids.model,
            text: "Totals come from `compute_total(booking.minutes)`.",
          },
        ],
      ),
      graph,
      files,
    );
    const support = grounded.explanations?.[0].support;
    expect(support?.level).toBe("inference");
  }, 30_000);

  it("discloses that a contained rollback may be conditional", async () => {
    const { graph, files, ids } = await bookingGraph();
    const grounded = groundExplanations(
      journey(
        graph,
        [ids.create, ids.add],
        [
          {
            nodeId: ids.add,
            text: "The function rolls back every failed write and always commits the reservation.",
          },
        ],
      ),
      graph,
      files,
    );
    const support = grounded.explanations?.[0].support;
    expect(support?.note).toContain("does not prove it executes on every path");
  }, 30_000);

  it("discloses that an absence claim rests only on searched results", async () => {
    const { graph, files, ids } = await bookingGraph();
    const grounded = groundExplanations(
      journey(
        graph,
        [ids.read],
        [
          {
            nodeId: ids.read,
            text: "The search found no booking, so no offline support mechanism exists.",
          },
        ],
      ),
      graph,
      files,
    );
    expect(grounded.explanations?.[0].support?.note).toContain(
      "not evidence of absence",
    );
  }, 30_000);

  it("marks a mixed explanation as only partially supported", async () => {
    const { graph, files, ids } = await bookingGraph();
    const grounded = groundExplanations(
      journey(
        graph,
        [ids.create],
        [
          {
            nodeId: ids.create,
            text: "Calls `db.add(booking)` and also `bookingAudit.writeLegacy()`.",
          },
        ],
      ),
      graph,
      files,
    );
    const support = grounded.explanations?.[0].support;
    // The verified citation is kept, the invented one is recorded as
    // missing, and the whole statement is marked partially supported
    // instead of reading as fully verified.
    expect(support?.level).toBe("partial");
    expect(support?.note).toContain("Partially supported");
    expect(support?.note).toContain("`bookingAudit.writeLegacy()`");
    expect(JSON.stringify(support?.sourceRefs).includes("writeLegacy")).toBe(
      false,
    );
    expect(
      JSON.stringify(support?.sourceRefs).includes("db.add(booking)"),
    ).toBe(true);
  }, 30_000);

  it("does not credit a fragment located far outside the explained node", async () => {
    const { graph, files, ids } = await bookingGraph();
    // The router declaration exists in bookings.py but far from the
    // create_booking handler: present in the file, unrelated to the
    // explained node's location.
    const grounded = groundExplanations(
      journey(
        graph,
        [ids.create],
        [
          {
            nodeId: ids.create,
            text: 'The handler opens with `router = APIRouter(prefix="/api", tags=["reservations"])`.',
          },
        ],
      ),
      graph,
      files,
    );
    const support = grounded.explanations?.[0].support;
    expect(support?.level).toBe("inference");
    expect(support?.sourceRefs).toBeUndefined();
  }, 30_000);

  it("marks a statement with no citations and no verified edges as interpretation", async () => {
    const { graph, files, ids } = await bookingGraph();
    const grounded = groundExplanations(
      journey(
        graph,
        [ids.model],
        [
          {
            nodeId: ids.model,
            text: "This model probably enforces booking quotas at the database level.",
          },
        ],
      ),
      graph,
      files,
    );
    const support = grounded.explanations?.[0].support;
    expect(support?.level).toBe("inference");
    expect(support?.note).toContain("model's interpretation");
  }, 30_000);

  it("never discards previously validated journeys while grounding", async () => {
    const { graph, files, ids } = await bookingGraph();
    // Sibling database operations (stage and commit) are separate journeys:
    // no edge connects them, so the path picks one persistence endpoint.
    const nodeIds = [ids.route, ids.create, ids.add];
    const before = journey(graph, nodeIds, [
      { nodeId: ids.route, text: "Receives the booking." },
      { nodeId: ids.create, text: "Creates and stages it." },
      { nodeId: ids.add, text: "Stages the write." },
    ]);
    expect(journeyIsValid(before, graph, files)).toBe(true);
    const grounded = groundExplanations(before, graph, files);
    expect(grounded.nodeIds).toEqual(before.nodeIds);
    expect(grounded.edgeIds).toEqual(before.edgeIds);
    expect(journeyIsValid(grounded, graph, files)).toBe(true);
    expect(grounded.explanations?.every((item) => item.support)).toBe(true);
    const committed = journey(
      graph,
      [ids.route, ids.create, ids.commit],
      [
        { nodeId: ids.route, text: "Receives the booking." },
        { nodeId: ids.create, text: "Handles it." },
        { nodeId: ids.commit, text: "Commits the transaction." },
      ],
    );
    expect(journeyIsValid(committed, graph, files)).toBe(true);
    expect(groundExplanations(committed, graph, files).nodeIds).toEqual(
      committed.nodeIds,
    );
  }, 30_000);
});
