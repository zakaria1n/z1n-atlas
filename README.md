# Z1N Atlas

**Visualize. Explore. Understand.**

Z1N Atlas is an application in development for exploring source code through a visual map and evidence-backed explanations. The current application provides a responsive welcome screen and development foundation.

Repository import, code analysis, graph visualization, AI explanations, and feature journeys are **planned** and are not available yet. No repository content is processed by the current application.

## Getting started

Use Node.js 22.12 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000. No environment variables are currently required.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
pnpm build
```

Use `pnpm format` to format project files. The app uses Next.js App Router, React, TypeScript, Tailwind CSS, ESLint, Prettier, and Vitest. Routes live in `src/app`, shared layout components in `src/components`, and global design tokens in `src/styles`. Additional feature and server modules will be introduced when needed.

## Principles

The intended experience is read-only: imported projects should never be modified or executed. Provider key handling and source-sharing details will be documented when those capabilities are implemented.
