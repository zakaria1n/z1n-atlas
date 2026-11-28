import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Development-only data endpoint for the renderer benchmark: serves the
 * recorded graph snapshots from `apps/web/bench/sigma/graphs`. It is
 * disabled in production builds unless explicitly re-enabled with
 * Z1N_BENCH_DATA=1, so benchmark fixtures are never part of the normal
 * application surface.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ snapshot: string }> },
) {
  const { snapshot } = await params;
  if (
    process.env.NODE_ENV === "production" &&
    process.env.Z1N_BENCH_DATA !== "1"
  )
    return new Response(null, { status: 404 });
  if (!/^[a-z0-9-]{1,64}$/.test(snapshot))
    return new Response(null, { status: 400 });
  try {
    const file = await readFile(
      path.join(process.cwd(), "bench", "sigma", "graphs", `${snapshot}.json`),
      "utf8",
    );
    return new Response(file, {
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
