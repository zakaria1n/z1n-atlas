import { describe, expect, it } from "vitest";
import type { CodeGraph } from "@z1n/contracts";
import { buildRepositoryContext, contextOverview } from "./builder";

const files = [
  {
    path: "package.json",
    content: '{"dependencies":{"next":"15","react":"19","express":"5"}}',
  },
  { path: "backend/main.py", content: "app = FastAPI()" },
  { path: "backend/app/bookings.py", content: "router = APIRouter()" },
  { path: "src/pages/index.tsx", content: "export default function Page()" },
];
const graph: CodeGraph = {
  nodes: [
    {
      id: "backend/app/bookings.py",
      path: "backend/app/bookings.py",
      exports: [],
    },
    {
      id: "backend/app/bookings.py#1",
      path: "backend/app/bookings.py",
      name: "createBooking",
      kind: "function",
      startLine: 1,
      endLine: 5,
      exports: [],
    },
    {
      id: "backend/app/bookings.py#6",
      path: "backend/app/bookings.py",
      name: "POST /api/bookings",
      kind: "route",
      startLine: 6,
      endLine: 9,
      exports: [],
    },
    {
      id: "src/pages/index.tsx#1",
      path: "src/pages/index.tsx",
      name: "BookingForm",
      kind: "function",
      startLine: 1,
      endLine: 4,
      exports: [],
    },
    {
      id: "backend/app/pricing.py#1",
      path: "backend/app/pricing.py",
      name: "calculatePrice",
      kind: "function",
      startLine: 1,
      endLine: 4,
      exports: [],
    },
  ],
  edges: [
    {
      id: "e1",
      source: "backend/app/bookings.py#6",
      target: "backend/app/bookings.py#1",
      kind: "http-route",
      confidence: "framework",
      evidenceId: "ev1",
    },
    {
      id: "e2",
      source: "src/pages/index.tsx#1",
      target: "backend/app/bookings.py#6",
      kind: "requests",
      confidence: "heuristic",
      evidenceId: "ev2",
    },
    {
      id: "e3",
      source: "backend/app/bookings.py#1",
      target: "src/pages/index.tsx#1",
      kind: "calls",
      confidence: "exact",
      evidenceId: "ev3",
    },
    {
      id: "e4",
      source: "backend/app/bookings.py#1",
      target: "backend/app/pricing.py#1",
      kind: "calls",
      confidence: "exact",
      evidenceId: "ev4",
    },
  ],
  evidence: [],
  unresolved: 0,
  unresolvedCalls: 2,
  notice: "",
};

describe("repository context builder", () => {
  it("separates source facts from structural heuristics", () => {
    const context = buildRepositoryContext("snap-1", files, graph);
    // Facts: manifests prove framework declarations, counts come from the
    // selection and the verified graph.
    expect(context.facts.frameworks).toEqual(
      expect.arrayContaining(["Next.js", "React", "Express"]),
    );
    expect(context.facts.manifests).toEqual(["package.json"]);
    expect(context.facts.symbols).toBe(4);
    expect(context.facts.relationships).toBe(4);
    expect(context.facts.routes).toEqual(["POST /api/bookings"]);
    expect(context.facts.unresolvedCalls).toBe(2);
    // Heuristics: hotspots are degree-ranked structural inferences.
    expect(context.heuristics.hotspots[0]).toMatchObject({
      name: "createBooking",
      kind: "function",
    });
    expect(context.limitations.join(" ")).toContain("not runtime traces");
  });
  it("renders a bounded overview with facts before heuristics", () => {
    const overview = contextOverview(
      buildRepositoryContext("snap-1", files, graph),
    );
    expect(overview).toContain("Repository snapshot snap-1");
    expect(overview).toContain("Next.js");
    expect(overview).toContain("STRUCTURAL INFERENCES");
    const factPosition = overview.indexOf("Frameworks");
    const heuristicPosition = overview.indexOf("STRUCTURAL INFERENCES");
    expect(factPosition).toBeLessThan(heuristicPosition);
    expect(overview.length).toBeLessThan(2_500);
  });
  it("caps routes and hotspots so large repositories stay bounded", () => {
    const manyRoutes: CodeGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        ...Array.from({ length: 30 }, (_, index) => ({
          id: `r${index}`,
          path: "backend/app/bookings.py",
          name: `GET /api/route-${index}`,
          kind: "route",
          startLine: 1,
          endLine: 2,
          exports: [],
        })),
      ],
    };
    const context = buildRepositoryContext("snap-2", files, manyRoutes);
    expect(context.facts.routes.length).toBeLessThanOrEqual(12);
    expect(context.facts.truncatedRoutes).toBe(true);
  });
});
