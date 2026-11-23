"use client";

import Link from "next/link";
import { useRef } from "react";
import { useRepositorySession } from "@/features/repository-import/repository-session";

export function EmptyWorkspace() {
  const { session } = useRepositorySession();
  const files = useRef<HTMLDialogElement>(null);
  const inspector = useRef<HTMLDialogElement>(null);
  const assistant = useRef<HTMLDialogElement>(null);
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
        <h1>Your atlas starts here.</h1>
        <p>File browsing and graph exploration are in development.</p>
        <Link href="/import" className="button primary">
          Explore import options →
        </Link>
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
        <p>File browsing is in development.</p>
        <Link href="/import" className="text-link">
          Import options →
        </Link>
      </dialog>
      <dialog
        ref={inspector}
        className="panel bottom-sheet"
        aria-labelledby="inspector-title"
      >
        <form method="dialog">
          <button className="close" aria-label="Close inspector">
            ×
          </button>
        </form>
        <h2 id="inspector-title">Code inspector</h2>
        <p>Source inspection is in development.</p>
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
