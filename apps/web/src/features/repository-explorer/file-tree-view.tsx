import type { TreeNode } from "./file-tree";

type Props = {
  nodes: TreeNode[];
  onSelect: (path: string) => void;
  expanded?: boolean;
};
export function FileTree({ nodes, onSelect, expanded = false }: Props) {
  return (
    <ul className="file-tree">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.kind === "directory" ? (
            <details open={expanded}>
              <summary>{node.name}</summary>
              <FileTree
                nodes={node.children}
                onSelect={onSelect}
                expanded={expanded}
              />
            </details>
          ) : (
            <button
              type="button"
              onClick={() => onSelect(node.path)}
              aria-label={node.path}
              title={node.path}
            >
              {node.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
