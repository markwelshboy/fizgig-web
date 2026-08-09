import { createContext, ReactNode, useContext, useMemo, useState } from "react";
import type { DatasetInfo } from "./api";

type SessionState = {
  dataset: DatasetInfo | null;
  setDataset: (dataset: DatasetInfo | null) => void;
  modelFamily: "krea2" | "klein";
  setModelFamily: (family: "krea2" | "klein") => void;
  triggerWord: string;
  setTriggerWord: (trigger: string) => void;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [dataset, setDataset] = useState<DatasetInfo | null>(null);
  const [modelFamily, setModelFamily] = useState<"krea2" | "klein">("krea2");
  const [triggerWord, setTriggerWord] = useState("sH1VX");

  const value = useMemo(
    () => ({ dataset, setDataset, modelFamily, setModelFamily, triggerWord, setTriggerWord }),
    [dataset, modelFamily, triggerWord],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
