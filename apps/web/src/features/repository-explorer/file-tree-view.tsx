import type { TreeNode } from "./file-tree";

type Props = { nodes: TreeNode[]; onSelect: (path: string) => void };
export function FileTree({ nodes, onSelect }: Props) {
  return (
    <ul className="file-tree">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.kind === "directory" ? (
            <details open>
              <summary>{node.name}</summary>
              <FileTree nodes={node.children} onSelect={onSelect} />
            </details>
          ) : (
            <button type="button" onClick={() => onSelect(node.path)}>
              {node.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
