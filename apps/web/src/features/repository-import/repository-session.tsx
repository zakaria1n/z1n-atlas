"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createImportCoordinator } from "./import-coordinator";

export type SourceFile = { path: string; size: number; content: string };
export type RepositorySession = {
  label: string;
  origin: "github" | "local";
  files: SourceFile[];
  skipped: number;
  truncated: boolean;
  commit?: string;
  inventory?: { path: string; size: number }[];
  indexTruncated?: boolean;
  readFile?: (path: string, signal?: AbortSignal) => Promise<SourceFile>;
};
type SessionContext = {
  session: RepositorySession | null;
  setSession: (session: RepositorySession | null) => void;
  beginImport: () => () => boolean;
  analysisId: string | undefined;
  setAnalysisId: (id: string | undefined) => void;
};
const Context = createContext<SessionContext | null>(null);
// Dev-only renderer-benchmark bootstrap: the Playwright benchmark seeds a
// recorded session and graph through sessionStorage so measurements run in
// the real workspace. Production builds compile this path out.
const BENCH_SESSION_KEY = "z1n_bench_session";
function benchSession(): RepositorySession | null {
  if (process.env.NODE_ENV === "production") return null;
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(BENCH_SESSION_KEY);
    return raw ? (JSON.parse(raw) as RepositorySession) : null;
  } catch {
    return null;
  }
}
export function RepositoryProvider({ children }: { children: ReactNode }) {
  const [session, updateSession] = useState<RepositorySession | null>(null);
  // Applied after mount so server and client render the same first pass,
  // and one frame late so the effect holds no synchronous state update.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const seeded = benchSession();
      if (seeded) updateSession(seeded);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const [analysisId, setAnalysisId] = useState<string | undefined>();
  function setSession(value: RepositorySession | null) {
    setAnalysisId(undefined);
    updateSession(value);
  }
  const coordinator = useRef(createImportCoordinator());
  function beginImport() {
    return coordinator.current.begin();
  }
  return (
    <Context.Provider
      value={{ session, setSession, beginImport, analysisId, setAnalysisId }}
    >
      {children}
    </Context.Provider>
  );
}
export function useRepositorySession(): SessionContext {
  const context = useContext(Context);
  if (!context) throw new Error("Repository session provider is missing.");
  return context;
}
