# Z1N Atlas

**Visualize. Explore. Understand.**

Z1N Atlas is a read-only application for exploring source code through a relationship graph and evidence. You can import a bounded selection from a public GitHub repository or choose a local folder, browse the selected files, inspect source, and analyze supported TypeScript/JavaScript relationships.

The analyzer resolves imports, re-exports, root TypeScript path aliases, selected symbols and static calls. It also identifies Next.js page entries, literal `fetch` requests, simple Express routes with a single router mount, static Next.js App Router endpoints and selected Prisma Client operations. Next.js conventions are recognized only when an imported package manifest declares Next.js. HTTP matches are **heuristic**; static relations are not runtime traces. Dynamic URLs, configuration inheritance, external packages, many framework patterns, other database libraries and runtime behavior are not fully resolved. Unresolved references are reported. Settings can discover models from OpenAI, Google Gemini and Anthropic; chat and Feature Journey are not yet available.

## Architecture

- `apps/web`: Next.js frontend, file selection, inspector and graph.
- `apps/api`: Fastify HTTP service for public GitHub import and isolated analysis.
- `packages/contracts`: shared Zod HTTP schemas and evidence validation.
- `packages/analysis-core`: TypeScript/JavaScript analysis using ts-morph and the TypeScript compiler.

Analysis runs in a Node worker with a timeout and heap limit; the application does not execute or modify imported source. Source and graph results are kept in memory, not a database. Worker heap limits do not replace deployment-level resource limits.

## Run locally

Use Node.js 22.12 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000. The API listens on `127.0.0.1:4000` by default. `pnpm dev` builds shared packages before starting both processes. For production-style local execution:

```sh
pnpm build
pnpm --filter @z1n/api start
# In another terminal:
pnpm --filter @z1n/web start
```

To use a different backend, set `NEXT_PUBLIC_API_URL` in `apps/web/.env.local` before building or starting the web app. It must be an HTTPS origin, except HTTP is permitted for localhost. Configure `WEB_ORIGIN` on the API to the exact frontend origin; `HOST` and `PORT` control its listener. The API defaults to loopback and must not be exposed publicly without deployment-level authentication, distributed rate limiting and resource controls. Environment examples are in `.env.example`.

## Privacy and limits

Local selection is read in the browser. Before analysis the app displays the configured backend address and asks for explicit consent to send selected local files; a remote backend receives their contents. Browser selection does not grant the server filesystem access. The server processes the submitted contents in memory, without running project code. The selection is discarded on reload or tab closure.

Provider keys are held in browser memory for the current tab and sent to the configured backend when requesting a model list or testing a model, then forwarded to the selected provider. They are not persisted by the application. Model discovery does not verify generation access, and listings may be incomplete. The optional test sends a short generation request that may incur provider charges. Provider integration is tested with mocks; live credentials have not been used to verify it.

Imports are limited to 25 files, 100 KB per file and 1 MB total. Common secrets, generated directories and unsupported file types are excluded by path, but filters cannot detect every secret in source content. Review your selection before sharing. GitHub API rate limits may prevent imports. Per-process request limits are not a distributed rate limiter.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
pnpm build
```

The graph uses React Flow and the inspector uses Prism React Renderer. The analysis engine uses ts-morph; these packages are distributed under their respective open-source licenses.
