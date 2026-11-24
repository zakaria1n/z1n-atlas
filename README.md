# Z1N Atlas

**Visualize. Explore. Understand.**

Z1N Atlas is a read-only application for exploring source code through a relationship graph and evidence. You can import a bounded selection from a public GitHub repository or choose a local folder, browse the selected files, inspect source, and analyze supported TypeScript/JavaScript relationships.

The analyzer resolves imports, re-exports, root TypeScript path aliases, selected symbols and static calls. It also identifies Next.js page entries, literal `fetch` requests, simple Express routes with a single router mount, static Next.js App Router endpoints and selected Prisma Client operations. Next.js conventions are recognized only when an imported package manifest declares Next.js. HTTP matches are **heuristic**; static relations are not runtime traces. Dynamic URLs, configuration inheritance, external packages, many framework patterns, other database libraries and runtime behavior are not fully resolved. Unresolved references are reported. Settings can discover models from OpenAI, Google Gemini and Anthropic. The assistant answers individual questions with bounded evidence and clickable citations. Feature Journey ranks candidate static paths by feature or symbol names and highlights their evidence in the graph; it may select the wrong candidate or miss paths.

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

For each assistant request, the app sends the selected files to the configured backend for analysis and bounded relevant excerpts to the selected AI provider after consent. Providers may retain submitted data according to their own policies. Only citations found in the analyzed selection are accepted, but a valid citation does not guarantee that the model's explanation is correct. The assistant can miss relevant evidence and is not a runtime trace. Requests may incur provider charges.

Feature Journey sends the selection to the configured backend again with consent. It does not use an AI provider. Every displayed transition comes from the static graph; heuristic matches and missing boundaries are identified as uncertain. Ranking uses names and a bounded search rather than understanding the complete application.

Imports are limited to 25 files, 100 KB per file and 1 MB total. Common secrets, generated directories and unsupported file types are excluded by path, but filters cannot detect every secret in source content. Review your selection before sharing. GitHub API rate limits may prevent imports. Per-process request limits are not a distributed rate limiter.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

The browser smoke test starts both applications, analyzes a synthetic local project through the real API, and mocks AI-provider responses. Stop any existing servers on ports 3000 and 4000 before running it.

## Try it

1. Start both applications, choose **Explore**, and import the public [Z1N Atlas repository](https://github.com/zakaria1n/z1n-atlas).
2. Open the workspace and analyze the selected files. The importer reports skipped files, so the resulting map is a partial view of the repository.
3. Choose a file or relationship to inspect its source. Switch **Graph scope** to include symbols, or enter a name under **Feature Journey** to highlight a candidate static path.
4. Optionally select a provider and model in Settings to ask an evidence-linked question. Read the sharing notice before sending source excerpts to a provider.

The screenshots show the running application. The journey example uses a synthetic React/Express/Prisma test project.

![Z1N Atlas welcome screen](docs/screenshots/home.png)
![Feature Journey highlighting a candidate path](docs/screenshots/journey.png)

## Dependencies and attribution

The graph uses [React Flow](https://reactflow.dev/) and the inspector uses [Prism React Renderer](https://github.com/FormidableLabs/prism-react-renderer). The analysis engine uses [ts-morph](https://github.com/dsherret/ts-morph). Their licenses and those of transitive packages are distributed with the dependencies; `pnpm licenses list --prod` lists the installed production licenses. Platform-specific image-processing binaries may include LGPL-licensed components; review their included notices when redistributing binaries.
