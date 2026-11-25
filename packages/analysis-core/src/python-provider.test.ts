import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeFiles } from "./analyze-files";
import { graphIsValid } from "@z1n/contracts";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/fastapi-booking",
);
function loadFixture() {
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

describe("Python analysis", () => {
  it("parses Python modules into verified file, class and function nodes", async () => {
    const files = loadFixture();
    const graph = await analyzeFiles(files);
    expect(graphIsValid(graph, files)).toBe(true);
    const models = graph.nodes.filter(
      (node) => node.path === "backend/app/models.py",
    );
    expect(models.map((node) => node.kind ?? "file")).toEqual(
      expect.arrayContaining(["file", "class"]),
    );
    const booking = models.find((node) => node.name === "Booking");
    expect(booking?.kind).toBe("class");
    const snippet = graph.evidence.find(
      (item) => item.filePath === "backend/app/models.py",
    );
    expect(
      files.find((file) => file.path === "backend/app/models.py"),
    ).toBeTruthy();
    expect(snippet?.snippet).toBeTruthy();
  }, 30_000);

  it("resolves relative imports and cross-module calls to real files", async () => {
    const graph = await analyzeFiles(loadFixture());
    const createBooking = graph.nodes.find(
      (node) => node.name === "create_booking",
    );
    const bookingClass = graph.nodes.find(
      (node) => node.name === "Booking" && node.kind === "class",
    );
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "calls" &&
          edge.source === createBooking?.id &&
          edge.target === bookingClass?.id,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "imports" &&
          edge.source === "backend/app/bookings.py" &&
          edge.target === "backend/app/models.py",
      ),
    ).toBe(true);
    const quote = graph.nodes.find((node) => node.name === "quote");
    const computeTotal = graph.nodes.find(
      (node) => node.name === "compute_total",
    );
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "calls" &&
          edge.source === quote?.id &&
          edge.target === computeTotal?.id,
      ),
    ).toBe(true);
  }, 30_000);

  it("extracts FastAPI routes with composed prefixes and their handlers", async () => {
    const graph = await analyzeFiles(loadFixture());
    const route = graph.nodes.find(
      (node) => node.kind === "route" && node.name === "POST /api/bookings",
    );
    expect(route?.path).toBe("backend/app/bookings.py");
    const createBooking = graph.nodes.find(
      (node) => node.name === "create_booking",
    );
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "handles" &&
          edge.source === route?.id &&
          edge.target === createBooking?.id,
      ),
    ).toBe(true);
    expect(
      graph.nodes.some(
        (node) =>
          node.kind === "route" &&
          node.name === "GET /api/bookings/{booking_id}",
      ),
    ).toBe(true);
    // The router prefix composes onto the app-mounted routes only.
    expect(
      graph.nodes.some(
        (node) => node.kind === "route" && node.name === "GET /health",
      ),
    ).toBe(true);
    expect(
      graph.nodes.some(
        (node) => node.kind === "route" && node.name === "POST /bookings",
      ),
    ).toBe(false);
  }, 30_000);

  it("reports SQLAlchemy session operations and links them to model classes", async () => {
    const graph = await analyzeFiles(loadFixture());
    const access = graph.nodes.filter(
      (node) =>
        node.kind === "database" && node.name === "SQLAlchemy add Booking",
    );
    expect(access).toHaveLength(1);
    const bookingClass = graph.nodes.find(
      (node) => node.name === "Booking" && node.kind === "class",
    );
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "references" &&
          edge.source === access[0]?.id &&
          edge.target === bookingClass?.id,
      ),
    ).toBe(true);
  }, 30_000);

  it("reports a relative import that leaves the project instead of guessing", async () => {
    const graph = await analyzeFiles([
      {
        path: "backend/app/store.py",
        content: "from .missing import thing\n\nthing\n",
      },
      { path: "backend/app/__init__.py", content: "" },
      { path: "backend/__init__.py", content: "" },
    ]);
    expect(graph.unresolvedItems?.map((item) => item.kind)).toContain("import");
    expect(graph.unresolvedItems?.[0]?.filePath).toBe("backend/app/store.py");
  }, 30_000);

  it("keeps line numbers and snippets exact on non-ASCII sources", async () => {
    const graph = await analyzeFiles([
      {
        path: "backend/app/café.py",
        content:
          '# café — notes\n\ndef prépare(thé: str) -> str:\n    return thé\n\nprépare("thé matcha")\n',
      },
    ]);
    const function_ = graph.nodes.find((node) => node.name === "prépare");
    expect(function_?.startLine).toBe(3);
    expect(function_?.endLine).toBe(4);
    const call = graph.edges.find((edge) => edge.kind === "calls");
    expect(call).toBeTruthy();
    const evidenceItem = graph.evidence.find(
      (item) => item.id === call?.evidenceId,
    );
    expect(evidenceItem?.snippet).toContain('prépare("thé matcha")');
    expect(evidenceItem?.startLine).toBe(6);
  }, 30_000);
});
