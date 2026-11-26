import { ts, type CompilerOptions } from "ts-morph";
import type { AnalyzerFile } from "./analyze-files";

export type ModuleResolver = (
  specifier: string,
  containingFile: string,
) => string | null;

/**
 * Resolves module specifiers against the imported files only. The TypeScript
 * resolver is used unchanged, but with a host that never consults the real
 * disk: the result does not depend on the machine that runs the analysis, and
 * packages outside the import cost no file-system lookups.
 */
export function createModuleResolver(
  files: AnalyzerFile[],
  options: CompilerOptions,
): ModuleResolver {
  const contents = new Map<string, string>();
  const directories = new Set<string>(["/workspace"]);
  for (const file of files) {
    const path = `/workspace/${file.path}`;
    contents.set(path, file.content);
    for (
      let index = path.indexOf("/", 1);
      index > 0;
      index = path.indexOf("/", index + 1)
    )
      directories.add(path.slice(0, index));
  }
  const host: ts.ModuleResolutionHost = {
    fileExists: (name) => contents.has(name),
    directoryExists: (name) => directories.has(name),
    getDirectories: (name) =>
      [...directories].filter(
        (directory) =>
          directory.startsWith(`${name}/`) &&
          !directory.slice(name.length + 1).includes("/"),
      ),
    readFile: (name) => contents.get(name),
    realpath: (name) => name,
    getCurrentDirectory: () => "/workspace",
    useCaseSensitiveFileNames: true,
  };
  const cache = new Map<string, string | null>();
  type AliasConfig = {
    directory: string;
    patterns: { prefix: string; targets: string[] }[];
  };
  // Monorepos declare path aliases in per-package tsconfig files; the global
  // compiler options cannot know all of them. When the shared resolution
  // fails for a non-relative specifier, the nearest tsconfig.json of the
  // importing file provides that package's own alias mapping.
  const aliasConfigs = new Map<string, AliasConfig | null>();
  function nearestAliasConfig(directory: string): AliasConfig | null {
    if (aliasConfigs.has(directory)) return aliasConfigs.get(directory)!;
    let result: AliasConfig | null = null;
    const raw = contents.get(`${directory}/tsconfig.json`);
    if (raw !== undefined) {
      try {
        const json = JSON.parse(
          raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
        );
        const rawPaths = json.compilerOptions?.paths;
        result = rawPaths
          ? {
              directory,
              patterns: Object.entries(rawPaths).map(([pattern, targets]) => ({
                prefix: pattern.replace(/\*$/, ""),
                targets: (targets as string[]).map((target) =>
                  target.replace(/\*$/, ""),
                ),
              })),
            }
          : null;
      } catch {
        result = null;
      }
    } else {
      const parent = directory.slice(0, directory.lastIndexOf("/"));
      if (parent && parent !== directory) result = nearestAliasConfig(parent);
    }
    aliasConfigs.set(directory, result);
    return result;
  }
  return (specifier, containingFile) => {
    const directory =
      containingFile.slice(0, containingFile.lastIndexOf("/")) || "/workspace";
    const key = `${directory}\n${specifier}`;
    let target = cache.get(key);
    if (target === undefined) {
      // Nearest-package tsconfig paths take precedence: in a monorepo the
      // merged global options can resolve another package's `@/*` alias to
      // the wrong file, so each importing file resolves through its own
      // package's mappings first, then falls back to the global options.
      const alias = /^\.\.?\//.test(specifier)
        ? null
        : nearestAliasConfig(directory);
      if (alias)
        for (const pattern of alias.patterns) {
          if (!specifier.startsWith(pattern.prefix)) continue;
          const rest = specifier.slice(pattern.prefix.length);
          for (const targetBase of pattern.targets) {
            const base = `${alias.directory}/${targetBase}${rest}`.replace(
              /\/\.(?=\/|$)/g,
              "",
            );
            const segments = base.split("/");
            for (let index = segments.length - 1; index > 2; index--) {
              if (segments[index] !== "..") continue;
              segments.splice(index - 1, 2);
            }
            const normalized = segments.join("/");
            for (const candidate of [
              normalized,
              `${normalized}.ts`,
              `${normalized}.tsx`,
              `${normalized}.mts`,
              `${normalized}.cts`,
              `${normalized}.js`,
              `${normalized}/index.ts`,
              `${normalized}/index.tsx`,
            ]) {
              if (!contents.has(candidate)) continue;
              target = candidate.replace(/^\/workspace\//, "");
              break;
            }
            if (target) break;
          }
          if (target) break;
        }
      if (!target)
        target =
          ts
            .resolveModuleName(
              specifier,
              `/workspace/${containingFile}`,
              options,
              host,
            )
            .resolvedModule?.resolvedFileName.replace(/^\/workspace\//, "") ??
          null;
      cache.set(key, target);
    }
    return target;
  };
}
