/** Imported files are placed under this directory in the in-memory project. */
export const WORKSPACE = "/workspace/";
const workspacePrefix = /^\/workspace\//;

/** The repository-relative path of a file placed in the in-memory project. */
export function workspacePath(absolutePath: string): string {
  return absolutePath.replace(workspacePrefix, "");
}

/** Identifier of a symbol node, built from its file and start offset. */
export function nodeId(filePath: string, start: number): string {
  return `${filePath}#${start}`;
}
