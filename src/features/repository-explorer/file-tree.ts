import type { SourceFile } from "@/features/repository-import/repository-session";

export type TreeNode =
  | { kind: "directory"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };
export function buildFileTree(files: SourceFile[], query = ""): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (query && !file.path.toLowerCase().includes(query.trim().toLowerCase()))
      continue;
    const parts = file.path.split("/");
    let children = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) {
        children.push({ kind: "file", name, path });
        continue;
      }
      let node = children.find(
        (item) => item.kind === "directory" && item.path === path,
      );
      if (!node) {
        node = { kind: "directory", name, path, children: [] };
        children.push(node);
      }
      if (node.kind === "directory") children = node.children;
    }
  }
  return root;
}
