import path from "node:path";
import { ts, type CompilerOptions } from "ts-morph";
import type { AnalyzerFile } from "./analyze-files";

export function compilerOptions(files: AnalyzerFile[]): {
  options: CompilerOptions;
  configNotice: string;
} {
  const options: CompilerOptions = {
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    baseUrl: "/workspace",
    jsx: ts.JsxEmit.Preserve,
  };
  const config = files.find(
    (file) => file.path === "tsconfig.json" || file.path === "jsconfig.json",
  );
  if (!config)
    return {
      options,
      configNotice:
        "No root TypeScript configuration was imported; aliases may be unresolved.",
    };
  const parsed = ts.parseConfigFileTextToJson(config.path, config.content);
  const raw: unknown = parsed.config;
  if (parsed.error || !raw || typeof raw !== "object" || Array.isArray(raw))
    return {
      options,
      configNotice:
        "The root configuration could not be parsed; aliases may be unresolved.",
    };
  const document = raw as Record<string, unknown>;
  const compiler = document.compilerOptions;
  if (!compiler || typeof compiler !== "object" || Array.isArray(compiler))
    return {
      options,
      configNotice:
        "Configuration inheritance and external packages are not resolved.",
    };
  const settings = compiler as Record<string, unknown>;
  if (
    typeof settings.baseUrl === "string" &&
    settings.baseUrl.length <= 256 &&
    !path.posix.isAbsolute(settings.baseUrl) &&
    !settings.baseUrl.includes("\\")
  ) {
    const root = path.posix.resolve("/workspace", settings.baseUrl);
    if (root === "/workspace" || root.startsWith("/workspace/"))
      options.baseUrl = root;
  }
  if (
    settings.paths &&
    typeof settings.paths === "object" &&
    !Array.isArray(settings.paths)
  ) {
    const mappings: Record<string, string[]> = Object.create(null);
    for (const [key, value] of Object.entries(settings.paths).slice(0, 64)) {
      if (
        key.length > 256 ||
        !/^[\w@./*-]+$/.test(key) ||
        (key.match(/\*/g)?.length ?? 0) > 1 ||
        !Array.isArray(value)
      )
        continue;
      const allowed = value
        .slice(0, 16)
        .filter(
          (item): item is string =>
            typeof item === "string" &&
            /^[\w@./*-]+$/.test(item) &&
            !path.posix.isAbsolute(item) &&
            (item.match(/\*/g)?.length ?? 0) <= 1 &&
            (path.posix.resolve(options.baseUrl!, item) === "/workspace" ||
              path.posix
                .resolve(options.baseUrl!, item)
                .startsWith("/workspace/")),
        );
      if (allowed.length) mappings[key] = allowed;
    }
    options.paths = mappings;
  }

  // Monorepo selections define aliases in package-level tsconfigs, not in
  // the root. Non-conflicting package mappings merge into the program so
  // symbol resolution sees them; a key that two packages map differently
  // stays out (ambiguous globally, resolved per-directory at the graph
  // layer instead), and the root configuration always wins.
  const packageAliases = new Map<string, { target: string; from: string }[]>();
  for (const file of files) {
    if (!/(?:^|\/)tsconfig\.json$/.test(file.path)) continue;
    if (file.path === "tsconfig.json") continue;
    if (Buffer.byteLength(file.content) > 100_000) continue;
    const parsed = ts.parseConfigFileTextToJson(file.path, file.content);
    const document = parsed.config as Record<string, unknown> | undefined;
    if (parsed.error || !document || typeof document !== "object") continue;
    const compiler = document.compilerOptions;
    if (!compiler || typeof compiler !== "object") continue;
    const settings = compiler as Record<string, unknown>;
    if (!settings.paths || typeof settings.paths !== "object") continue;
    const configDir = path.posix.dirname(
      path.posix.join("/workspace", file.path),
    );
    for (const [key, value] of Object.entries(
      settings.paths as Record<string, unknown>,
    ).slice(0, 64)) {
      if (
        key.length > 256 ||
        !/^[\w@./*-]+$/.test(key) ||
        (key.match(/\*/g)?.length ?? 0) > 1 ||
        !Array.isArray(value) ||
        options.paths?.[`#${key}`]
      )
        continue;
      for (const item of value.slice(0, 16)) {
        if (
          typeof item !== "string" ||
          !/^[\w@./*-]+$/.test(item) ||
          path.posix.isAbsolute(item) ||
          (item.match(/\*/g)?.length ?? 0) > 1
        )
          continue;
        const resolvedTarget = path.posix.normalize(
          path.posix.join(configDir, item),
        );
        if (!resolvedTarget.startsWith("/workspace/")) continue;
        // TypeScript resolves paths targets against the program baseUrl,
        // so package-local targets are stored relative to it.
        const target = path.posix.relative("/workspace", resolvedTarget);
        const entries = packageAliases.get(key) ?? [];
        entries.push({ target, from: file.path });
        packageAliases.set(key, entries);
      }
    }
  }
  const mergedPaths: Record<string, string[]> = (options.paths ??
    Object.create(null)) as Record<string, string[]>;
  for (const [key, entries] of packageAliases) {
    const distinct = new Set(entries.map((entry) => entry.target));
    if (entries.length > 1 && distinct.size > 1) continue;
    mergedPaths[key] = [...distinct];
  }
  options.paths = mergedPaths;
  return {
    options,
    configNotice:
      options.paths && Object.keys(options.paths).length
        ? "Root and non-conflicting package path aliases are supported; configuration inheritance and external packages are not resolved."
        : "Root path aliases are supported; configuration inheritance and external packages are not resolved.",
  };
}
