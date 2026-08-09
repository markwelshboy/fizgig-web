import { createContext, Dispatch, ReactNode, SetStateAction, useContext, useMemo, useState } from "react";
import type { DatasetInfo } from "./api";

type SessionState = {
  dataset: DatasetInfo | null;
  setDataset: Dispatch<SetStateAction<DatasetInfo | null>>;
  modelFamily: "krea2" | "klein";
  setModelFamily: Dispatch<SetStateAction<"krea2" | "klein">>;
  triggerWord: string;
  setTriggerWord: Dispatch<SetStateAction<string>>;
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
