import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeFiles } from "@z1n/analysis-core";
import { graphIsValid, journeyIsValid } from "@z1n/contracts";
import { findJourney } from "./find-journey";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures",
);
function load(name: string) {
  const root = path.join(fixturesDir, name);
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
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
describe("static exploration on representative fixtures", () => {
  it("follows registration from the form to the database in the full-stack fixture", () => {
    const files = load("react-express-auth");
    const graph = analyzeFiles(files);
    expect(graphIsValid(graph, files)).toBe(true);
    const journey = findJourney("How does user registration work?", graph);
    expect(journeyIsValid(journey, graph)).toBe(true);
    const names = journey.nodeIds.map(
      (id) => graph.nodes.find((node) => node.id === id)?.name,
    );
    expect(names).toEqual([
      "RegisterForm",
      "handleRegister",
      "POST /api/auth/register", // request
      "POST /api/auth/register", // route
      "register",
      "create",
      "create",
      "Prisma user.create",
    ]);
    expect(
      journey.edgeIds.map(
        (id) => graph.edges.find((edge) => edge.id === id)?.kind,
      ),
    ).toEqual([
      "handles-event",
      // The request is reported at the call site of the API-client wrapper,
      // so the path goes from the handler straight to its request.
      "requests",
      "http-route",
      "handles",
      "calls",
      "calls",
      "database-access",
    ]);
    expect(journey.uncertainties.join(" ")).toContain("heuristic");
    expect(journey.mode).toBe("static");
  });
  it("follows a session refresh through a request wrapper and an inline handler", () => {
    const files = load("react-express-auth");
    const graph = analyzeFiles(files);
    const journey = findJourney("refresh session", graph);
    const names = journey.nodeIds.map(
      (id) => graph.nodes.find((node) => node.id === id)?.name,
    );
    expect(names).toEqual([
      "SessionStatus",
      "handleRefresh",
      "GET /api/auth/session",
      "GET /api/auth/session",
      "GET /api/auth/session handler",
      "loadSession",
      "Prisma session.findUnique",
    ]);
  });
  it("traces a Pages Router sign-in through axios to its API route", () => {
    const files = load("next-pages-router");
    const graph = analyzeFiles(files);
    expect(graphIsValid(graph, files)).toBe(true);
    // Static exploration answers by names: nothing in this fixture is named
    // "user", so the question names the sign-in itself.
    const journey = findJourney("login", graph);
    const names = journey.nodeIds.map(
      (id) => graph.nodes.find((node) => node.id === id)?.name,
    );
    expect(names[0]).toBe("Home");
    expect(names[1]).toBe("LoginForm");
    expect(names).toContain("handleLogin");
    expect(names).toContain("GET /api/session");
    expect(names).toContain("ANY /api/session");
    // The path continues past the route into the session loader.
    expect(names[journey.nodeIds.length - 1]).toBe("loadSession");
    expect(journey.uncertainties.join(" ")).toContain("heuristic");
  });
  it("stops at the client when no backend route matches and says so", () => {
    const files = load("no-matching-route");
    const graph = analyzeFiles(files);
    expect(graphIsValid(graph, files)).toBe(true);
    const journey = findJourney("retry payment", graph);
    expect(journey.nodeIds.length).toBeGreaterThan(1);
    expect(journey.uncertainties.join(" ")).toContain(
      "No supported backend route",
    );
    expect(
      journey.edgeIds.some(
        (id) =>
          graph.edges.find((edge) => edge.id === id)?.kind === "http-route",
      ),
    ).toBe(false);
  });
  it("reports a question nothing answers instead of an unrelated path", () => {
    const files = load("react-express-auth");
    const graph = analyzeFiles(files);
    const journey = findJourney("dashboard export", graph);
    expect(journey.nodeIds).toEqual([]);
    expect(journey.uncertainties[0]).toContain("No analyzed code matches");
  });
});
