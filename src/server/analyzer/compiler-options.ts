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
  return {
    options,
    configNotice:
      "Root path aliases are supported; configuration inheritance and external packages are not resolved.",
  };
}
