"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { ModelList, Provider } from "@z1n/contracts";

export type ProviderSession = {
  provider: Provider;
  apiKey: string;
  model: string;
  list: ModelList | null;
};
const initial: ProviderSession = {
  provider: "openai",
  apiKey: "",
  model: "",
  list: null,
};
const Context = createContext<{
  session: ProviderSession;
  setSession: (value: ProviderSession) => void;
} | null>(null);
export function ProviderSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ProviderSession>(initial);
  return (
    <Context.Provider value={{ session, setSession }}>
      {children}
    </Context.Provider>
  );
}
export function useProviderSession() {
  const value = useContext(Context);
  if (!value) throw new Error("Provider session is missing.");
  return value;
}
