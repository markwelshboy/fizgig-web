import { createContext, Dispatch, ReactNode, SetStateAction, useContext, useMemo, useState } from "react";
import type { DatasetInfo, ProjectInfo, ProjectRevision, RunInfo } from "./api";

type SessionState = {
  project: ProjectInfo | null;
  setProject: Dispatch<SetStateAction<ProjectInfo | null>>;
  revision: ProjectRevision | null;
  setRevision: Dispatch<SetStateAction<ProjectRevision | null>>;
  run: RunInfo | null;
  setRun: Dispatch<SetStateAction<RunInfo | null>>;
  dataset: DatasetInfo | null;
  setDataset: Dispatch<SetStateAction<DatasetInfo | null>>;
  modelFamily: "krea2" | "klein";
  setModelFamily: Dispatch<SetStateAction<"krea2" | "klein">>;
  triggerWord: string;
  setTriggerWord: Dispatch<SetStateAction<string>>;
  closeProject: () => void;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [revision, setRevision] = useState<ProjectRevision | null>(null);
  const [run, setRun] = useState<RunInfo | null>(null);
  const [dataset, setDataset] = useState<DatasetInfo | null>(null);
  const [modelFamily, setModelFamily] = useState<"krea2" | "klein">("krea2");
  const [triggerWord, setTriggerWord] = useState("");

  function closeProject() {
    setProject(null);
    setRevision(null);
    setRun(null);
    setDataset(null);
    setTriggerWord("");
  }

  const value = useMemo(
    () => ({
      project,
      setProject,
      revision,
      setRevision,
      run,
      setRun,
      dataset,
      setDataset,
      modelFamily,
      setModelFamily,
      triggerWord,
      setTriggerWord,
      closeProject,
    }),
    [project, revision, run, dataset, modelFamily, triggerWord],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
