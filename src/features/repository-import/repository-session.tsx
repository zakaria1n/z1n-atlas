"use client";
import { createContext, useContext, useState, type ReactNode } from "react";

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
};
const Context = createContext<SessionContext | null>(null);
export function RepositoryProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<RepositorySession | null>(null);
  return (
    <Context.Provider value={{ session, setSession }}>
      {children}
    </Context.Provider>
  );
}
export function useRepositorySession(): SessionContext {
  const context = useContext(Context);
  if (!context) throw new Error("Repository session provider is missing.");
  return context;
}
