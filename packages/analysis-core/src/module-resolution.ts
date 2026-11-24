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
  return (specifier, containingFile) => {
    const directory =
      containingFile.slice(0, containingFile.lastIndexOf("/")) || "/workspace";
    const key = `${directory}\n${specifier}`;
    let target = cache.get(key);
    if (target === undefined) {
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
