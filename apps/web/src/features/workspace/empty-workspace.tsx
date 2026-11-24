"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useRepositorySession,
  type SourceFile,
} from "@/features/repository-import/repository-session";
import { buildFileTree } from "@/features/repository-explorer/file-tree";
import { FileTree } from "@/features/repository-explorer/file-tree-view";
import { AnalysisCanvas } from "@/features/graph/analysis-canvas";
import { CodeView } from "@/features/repository-explorer/code-view";
import { Assistant } from "@/features/chat/assistant";

// A filtered list is rendered fully expanded, so its size is bounded to keep
// the drawer responsive on large indexes.
const MAX_FILTER_RESULTS = 500;

export function EmptyWorkspace() {
  const { session } = useRepositorySession();
  const files = useRef<HTMLDialogElement>(null);
  const inspector = useRef<HTMLDialogElement>(null);
  const assistant = useRef<HTMLDialogElement>(null);
  const inspectionRequest = useRef<AbortController | null>(null);
  useEffect(() => () => inspectionRequest.current?.abort(), []);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<number | undefined>();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [selected, setSelected] = useState<SourceFile | null>(null);
  const [inspectionBusy, setInspectionBusy] = useState(false);
  const [inspectionError, setInspectionError] = useState("");
  const indexed = session?.inventory;
  const analyzed = session?.files;
  const inventory = useMemo(
    () => indexed ?? analyzed ?? [],
    [indexed, analyzed],
  );
  const needle = query.trim().toLowerCase();
  const { tree, matchCount } = useMemo(() => {
    if (!needle) return { tree: buildFileTree(inventory), matchCount: 0 };
    const matches = inventory.filter((file) =>
      file.path.toLowerCase().includes(needle),
    );
    return {
      tree: buildFileTree(matches.slice(0, MAX_FILTER_RESULTS)),
      matchCount: matches.length,
    };
  }, [inventory, needle]);
  function selectFile(path: string, line?: number) {
    inspectionRequest.current?.abort();
    inspectionRequest.current = null;
    setSelectedLine(line);
    setSelectedPath(path);
    setSelected(null);
    setInspectionError("");
    setInspectionBusy(false);
    files.current?.close();
    if (!inspector.current?.open) inspector.current?.showModal();
    const existing = session?.files.find((file) => file.path === path);
    if (existing) {
      setSelected(existing);
      return;
    }
    if (!session?.readFile) {
      setInspectionError("This file is unavailable for inspection.");
      return;
    }
    const controller = new AbortController();
    inspectionRequest.current = controller;
    setInspectionBusy(true);
    void session
      .readFile(path, controller.signal)
      .then((file) => {
        if (inspectionRequest.current === controller) setSelected(file);
      })
      .catch((error) => {
        if (inspectionRequest.current === controller)
          setInspectionError(
            error instanceof Error
              ? error.message
              : "Could not read this file.",
          );
      })
      .finally(() => {
        if (inspectionRequest.current === controller) {
          inspectionRequest.current = null;
          setInspectionBusy(false);
        }
      });
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
      {session ? (
        <AnalysisCanvas session={session} onOpenFile={selectFile} />
      ) : (
        <div className="empty">
          <div className="empty-mark" aria-hidden="true">
            ✳
          </div>
          <h1>Your atlas starts here.</h1>
          <p>Import a project to inspect its files and build a source map.</p>
          <Link href="/import" className="button primary">
            Explore import options →
          </Link>
        </div>
      )}
      <button
        className="inspector-trigger secondary"
        onClick={() => inspector.current?.showModal()}
      >
        Code inspector
      </button>
      <button
        className="orb"
        aria-label="Open AI assistant"
        onClick={() => {
          setAssistantOpen(true);
          assistant.current?.showModal();
        }}
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
              {inventory.length} indexed paths · {session.files.length} files in
              the current analysis
              {session.indexTruncated ? " · index is incomplete" : ""}.
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
              <FileTree
                nodes={tree}
                onSelect={selectFile}
                expanded={Boolean(needle)}
              />
            ) : (
              <p>No matching files.</p>
            )}
            {matchCount > MAX_FILTER_RESULTS && (
              <p>
                Showing the first {MAX_FILTER_RESULTS} of {matchCount} matching
                paths. Refine the filter to narrow the list.
              </p>
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
        onClose={() => {
          inspectionRequest.current?.abort();
          inspectionRequest.current = null;
          setInspectionBusy(false);
        }}
      >
        <form method="dialog">
          <button className="close" aria-label="Close inspector">
            ×
          </button>
        </form>
        <h2 id="inspector-title">Code inspector</h2>
        {inspectionBusy && <p role="status">Reading source…</p>}
        {inspectionError && <p role="alert">{inspectionError}</p>}
        {selected ? (
          <>
            <p className="source-path">{selected.path}</p>
            {!session?.files.some((file) => file.path === selected.path) && (
              <p>
                This file is not included in the current graph or AI context.
              </p>
            )}
            <CodeView file={selected} highlightLine={selectedLine} />
          </>
        ) : !inspectionBusy && !inspectionError && !selectedPath ? (
          <p>Select a file in the Files panel to inspect its source.</p>
        ) : null}
      </dialog>
      <dialog
        ref={assistant}
        className="panel assistant-panel"
        aria-labelledby="assistant-title"
        onClose={() => setAssistantOpen(false)}
      >
        <form method="dialog">
          <button className="close" aria-label="Close assistant">
            ×
          </button>
        </form>
        <h2 id="assistant-title">AI assistant</h2>
        {assistantOpen && (
          <Assistant
            session={session}
            onOpenCitation={(path, line) => {
              assistant.current?.close();
              selectFile(path, line);
            }}
          />
        )}
      </dialog>
    </main>
  );
}
