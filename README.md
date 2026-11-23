# Z1N Atlas

**Visualize. Explore. Understand.**

Z1N Atlas is an application in development for exploring source code through a visual map and evidence-backed explanations. The application provides responsive welcome, import, settings, and empty workspace screens. It can read a bounded selection of source files from a public GitHub repository or a browser-selected local folder and display an import summary.

File browsing, code analysis, graph visualization, AI explanations, and feature journeys are **planned** and are not available yet. Imported source is kept in browser memory for the current app session; the workspace does not yet display it.

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

GitHub import reads only public default branches and enforces a maximum of 25 files, 100 KB per file, and 1 MB of source. It excludes common secret paths, generated directories, and unsupported file types; these filters cannot guarantee that source files contain no secrets. GitHub API rate limits may prevent imports. The per-process request limit is not a distributed rate limiter; production deployments need appropriate shared rate limiting.

Local folder selection reads supported files in the browser without uploading them. The same limits and path exclusions apply. Files are held in memory across app navigation; reloading or closing the tab discards them. Browsers without a directory picker or directory file input cannot use local selection.
