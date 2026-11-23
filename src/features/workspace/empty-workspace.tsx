"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useRepositorySession } from "@/features/repository-import/repository-session";
import { buildFileTree } from "@/features/repository-explorer/file-tree";
import { FileTree } from "@/features/repository-explorer/file-tree-view";
import { CodeView } from "@/features/repository-explorer/code-view";

export function EmptyWorkspace() {
  const { session } = useRepositorySession();
  const files = useRef<HTMLDialogElement>(null);
  const inspector = useRef<HTMLDialogElement>(null);
  const assistant = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = session?.files.find((file) => file.path === selectedPath);
  const tree = buildFileTree(session?.files ?? [], query);
  function selectFile(path: string) {
    setSelectedPath(path);
    files.current?.close();
    inspector.current?.showModal();
  }
  return (
    <main className="workspace">
      <div className="workspace-bar">
        <span>Explore / {session ? session.label : "No project open"}</span>
        <button
          className="secondary"
          onClick={() => files.current?.showModal()}
        >
          Files
        </button>
      </div>
      <div className="empty">
        <div className="empty-mark" aria-hidden="true">
          ✳
        </div>
        <h1>{session ? "Your files are ready." : "Your atlas starts here."}</h1>
        <p>
          {session
            ? "Open Files to inspect the source. Graph exploration is in development."
            : "Import a project to inspect its files. Graph exploration is in development."}
        </p>
        {session ? (
          <button
            className="button primary"
            onClick={() => files.current?.showModal()}
          >
            Browse files →
          </button>
        ) : (
          <Link href="/import" className="button primary">
            Explore import options →
          </Link>
        )}
      </div>
      <button
        className="inspector-trigger secondary"
        onClick={() => inspector.current?.showModal()}
      >
        Code inspector
      </button>
      <button
        className="orb"
        aria-label="About AI assistant"
        onClick={() => assistant.current?.showModal()}
      >
        ✦
      </button>
      <dialog
        ref={files}
        className="panel drawer"
        aria-labelledby="files-title"
      >
        <form method="dialog">
          <button className="close" aria-label="Close files">
            ×
          </button>
        </form>
        <h2 id="files-title">Files</h2>
        {session ? (
          <>
            <p>
              {session.files.length} files available
              {session.skipped || session.truncated
                ? "; selection is incomplete"
                : ""}
              .
            </p>
            <label htmlFor="file-search">Filter files</label>
            <input
              id="file-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search paths"
            />
            {tree.length ? (
              <FileTree nodes={tree} onSelect={selectFile} />
            ) : (
              <p>No matching files.</p>
            )}
          </>
        ) : (
          <>
            <p>No project is open.</p>
            <Link href="/import" className="text-link">
              Import options →
            </Link>
          </>
        )}
      </dialog>
      <dialog
        ref={inspector}
        className="panel bottom-sheet inspector"
        aria-labelledby="inspector-title"
      >
        <form method="dialog">
          <button className="close" aria-label="Close inspector">
            ×
          </button>
        </form>
        <h2 id="inspector-title">Code inspector</h2>
        {selected ? (
          <>
            <p className="source-path">{selected.path}</p>
            <CodeView file={selected} />
          </>
        ) : (
          <p>Select a file in the Files panel to inspect its source.</p>
        )}
      </dialog>
      <dialog
        ref={assistant}
        className="panel assistant-panel"
        aria-labelledby="assistant-title"
      >
        <form method="dialog">
          <button className="close" aria-label="Close assistant">
            ×
          </button>
        </form>
        <h2 id="assistant-title">AI assistant</h2>
        <p>
          AI explanations are not available yet. Provider configuration is
          planned in Settings.
        </p>
        <Link href="/settings" className="text-link">
          View settings →
        </Link>
      </dialog>
    </main>
  );
}
