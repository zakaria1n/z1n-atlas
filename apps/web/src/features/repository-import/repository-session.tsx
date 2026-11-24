"use client";
import {
  createContext,
  useContext,
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
};
type SessionContext = {
  session: RepositorySession | null;
  setSession: (session: RepositorySession | null) => void;
  beginImport: () => () => boolean;
  analysisId: string | undefined;
  setAnalysisId: (id: string | undefined) => void;
};
const Context = createContext<SessionContext | null>(null);
export function RepositoryProvider({ children }: { children: ReactNode }) {
  const [session, updateSession] = useState<RepositorySession | null>(null);
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
