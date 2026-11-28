# Renderer benchmark assets

This directory holds the renderer benchmark material. It is deliberately
outside `apps/web/public`, so none of it is served in production; the
`/sigma-bench` page reads snapshots through the development-gated
`/sigma-bench/data` route (404 in production unless `Z1N_BENCH_DATA=1`).

- `graphs/` — recorded CodeGraph snapshots (OmniSport Digitale, Z1N Atlas,
  dub-scale). Regenerate with `node make-graphs.mjs` (see the script header
  for its inputs).
- `make-graphs.mjs` — the reproducible snapshot generator.
- `LICENSES.md` — license notes for the rendering stack.

The vendored ForceAtlas2 CommonJS copies used by the first benchmark are gone:
both the benchmark page and the production workspace now use the same bundled
FA2 web worker (`apps/web/src/features/graph/renderer/fa2.worker.ts`), so
benchmarks measure the shipping code path.

Rendering stack licenses (all MIT): sigma.js © jacomyal and contributors,
graphology © graphology contributors, graphology-layout-forceatlas2 ©
graphology contributors.
