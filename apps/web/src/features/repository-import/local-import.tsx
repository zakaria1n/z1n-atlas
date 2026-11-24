"use client";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import {
  directoryFiles,
  readLocalFiles,
  selectedFiles,
  type Directory,
  type LocalEntry,
  type LocalResult,
} from "./local-reader";

import { useRepositorySession } from "./repository-session";
import { ANALYSIS_LIMITS, INDEX_LIMITS } from "./limits-copy";

type PickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: "read" }) => Promise<Directory>;
};
export function LocalImport() {
  const { setSession, beginImport } = useRepositorySession();
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const [capability, setCapability] = useState<
    "checking" | "picker" | "fallback" | "unsupported"
  >("checking");
  const [result, setResult] = useState<LocalResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (input.current) input.current.setAttribute("webkitdirectory", "");
    setCapability(
      typeof (window as PickerWindow).showDirectoryPicker === "function"
        ? "picker"
        : input.current && "webkitdirectory" in input.current
          ? "fallback"
          : "unsupported",
    );
  }, []);
  async function read(
    entries: (signal: AbortSignal) => AsyncIterable<LocalEntry>,
  ) {
    const isCurrent = beginImport();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const selection = await readLocalFiles(entries(controller.signal), {
        signal: controller.signal,
      });
      if (!isCurrent() || controller.signal.aborted) return;
      setResult(selection);
      setSession({ label: "Local folder", origin: "local", ...selection });
    } catch {
      if (!isCurrent() || controller.signal.aborted) return;
      setError(
        "The folder could not be read safely. Check permissions and folder depth, then try again.",
      );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function choose() {
    setError("");
    if (capability === "fallback") {
      input.current?.click();
      return;
    }
    try {
      const directory = await (window as PickerWindow).showDirectoryPicker!({
        mode: "read",
      });
      await read((signal) => directoryFiles(directory, signal));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError(
        "Folder access was not granted or the folder could not be opened.",
      );
    }
  }
  async function fallback(event: ChangeEvent<HTMLInputElement>) {
    const element = event.currentTarget;
    const files = element.files;
    if (files?.length) await read(() => selectedFiles(files));
    element.value = "";
  }
  return (
    <section className="option">
      <div className="option-icon mint" aria-hidden="true">
        ⌑
      </div>
      <h2>Local folder</h2>
      <p>
        Your browser asks you to choose a folder. Selection stays in this
        browser. Analysis sends selected source to the configured backend only
        after your consent. The app never writes to or runs your files.
      </p>
      <p>
        Limits: {ANALYSIS_LIMITS} are selected for analysis; {INDEX_LIMITS}.
        Common secret paths, generated folders, binaries and unsupported file
        types are excluded; review your folder because filters cannot detect
        every secret.
      </p>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={fallback}
        aria-label="Choose a folder"
      />
      <button
        type="button"
        className="import-button"
        onClick={choose}
        disabled={
          busy || capability === "checking" || capability === "unsupported"
        }
      >
        {busy ? "Reading folder…" : "Choose local folder"}
      </button>
      {capability === "unsupported" && (
        <p role="status">
          This browser does not support folder selection. Try a current
          Chromium-based browser.
        </p>
      )}
      <p aria-live="polite">
        {busy && "Reading eligible files on this device."}
      </p>
      {busy && (
        <button
          type="button"
          className="provider-clear"
          onClick={() => pending.current?.abort()}
        >
          Cancel folder read
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result && (
        <div className="result" role="status">
          <h3>Folder read</h3>
          <p>
            {result.files.length} files selected for analysis · {result.skipped}{" "}
            files skipped
          </p>
          <p>
            {result.inventory.length} eligible paths indexed for inspection
            {result.indexTruncated ? "; index is incomplete" : ""}.
          </p>
          {result.truncated && (
            <p>Selection was limited; coverage is incomplete.</p>
          )}
          <p>
            Excluded folders are not included in the skipped file count. The
            selection is held in memory until reload or tab closure.
          </p>
          <Link className="text-link" href="/workspace">
            Browse imported files →
          </Link>
        </div>
      )}
    </section>
  );
}
