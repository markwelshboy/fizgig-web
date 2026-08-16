import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  getActivityStatus,
  notifyRuntime,
  subscribeLocalActivity,
  subscribeRuntimeNotifications,
  type ActivityStatus,
  type RuntimeNotification,
} from "./activity-api";
import { getProjectRevision, getRun, inspectDataset, type ProjectInfo } from "./api";
import { CaptionsStagePage } from "./pages/CaptionsStagePage";
import { ImagePrepWorkbenchPageV6 } from "./pages/ImagePrepWorkbenchPageV6";
import { PreferencesPage } from "./pages/PreferencesPage";
import { SamplesPage } from "./pages/SamplesPage";
import { StartPage } from "./pages/StartPage";
import { TrainingPageShell } from "./pages/TrainingPageShell";
import { ProjectTransferDialog } from "./ProjectTransferDialog";
import { useSession } from "./session";
import { getTrainingModelState, type TrainingModelState } from "./training-models-api";

const nav = [
  ["ti-hexagon-number-1", "Start", "/"],
  ["ti-hexagon-number-2", "Image Prep", "/image-prep"],
  ["ti-hexagon-number-3", "Captions", "/captions"],
  ["ti-hexagon-number-4", "Sampling", "/samples"],
  ["ti-hexagon-number-5", "Training", "/training"],
];

const IDLE: ActivityStatus = { busy: false, label: "Idle", detail: "", active_count: 0, elapsed_seconds: 0 };

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    project,
    revision,
    modelFamily,
    closeProject,
    setProject,
    setRevision,
    setRun,
    setDataset,
    setModelFamily,
    setTriggerWord,
  } = useSession();
  const [backendActivity, setBackendActivity] = useState<ActivityStatus>(IDLE);
  const [localActivity, setLocalActivity] = useState<ActivityStatus>(IDLE);
  const [notification, setNotification] = useState<RuntimeNotification | null>(null);
  const [trainingModels, setTrainingModels] = useState<TrainingModelState | null>(null);
  const [transferMode, setTransferMode] = useState<"export" | "import" | null>(null);
  const activity = localActivity.busy ? localActivity : backendActivity;
  const activeModelFamily = revision?.model_family && revision.model_family !== "generic" ? revision.model_family : modelFamily;
  const activeTrainingFamily = trainingModels?.families.find((family) => family.id === activeModelFamily);
  const trainingSetupMissing = location.pathname === "/training" && Boolean(project && activeTrainingFamily && !activeTrainingFamily.ready);

  useEffect(() => subscribeLocalActivity(setLocalActivity), []);

  useEffect(() => subscribeRuntimeNotifications((next) => {
    setNotification(next);
    window.setTimeout(() => setNotification((current) => current?.id === next.id ? null : current), 5500);
  }), []);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const next = await getActivityStatus();
        if (!stopped) setBackendActivity(next);
      } catch {
        if (!stopped) setBackendActivity(IDLE);
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (location.pathname !== "/training") return;
    let stopped = false;
    async function refreshTrainingModels() {
      try {
        const next = await getTrainingModelState();
        if (!stopped) setTrainingModels(next);
      } catch {
        if (!stopped) setTrainingModels(null);
      }
    }
    void refreshTrainingModels();
    const timer = window.setInterval(() => void refreshTrainingModels(), 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [location.pathname, activeModelFamily]);

  function onCloseProject() {
    closeProject();
    navigate("/");
  }

  async function openImportedProject(imported: ProjectInfo) {
    // The backend import has already succeeded at this point. Put that project into the session
    // immediately, then hydrate richer state best-effort. An analysis-only/custom archive may
    // intentionally omit image bytes, but that must never make a successful import look like it failed.
    setProject(imported);
    setTriggerWord(imported.trigger_word || "");
    setRun(null);
    setRevision(null);
    setDataset(null);
    navigate("/");

    const currentRevision = imported.dataset_revisions.find((entry) => entry.id === imported.current_dataset_revision)
      ?? imported.dataset_revisions[imported.dataset_revisions.length - 1];
    if (currentRevision) {
      if (currentRevision.model_family === "krea2" || currentRevision.model_family === "klein") {
        setModelFamily(currentRevision.model_family);
      }
      try {
        const fullRevision = await getProjectRevision(imported.id, currentRevision.id);
        setRevision(fullRevision);
        try {
          setDataset(await inspectDataset(fullRevision.files_path));
        } catch (exc) {
          setDataset(null);
          notifyRuntime(`Project imported, but its selected archive does not contain a fully inspectable working dataset: ${exc instanceof Error ? exc.message : String(exc)}`, "info");
        }
      } catch (exc) {
        notifyRuntime(`Project imported, but its current dataset revision could not be opened: ${exc instanceof Error ? exc.message : String(exc)}`, "info");
      }
    }

    if (imported.current_run) {
      try {
        setRun(await getRun(imported.id, imported.current_run));
      } catch (exc) {
        notifyRuntime(`Project imported; the selected archive does not contain the current run in a reviewable form: ${exc instanceof Error ? exc.message : String(exc)}`, "info");
      }
    }

    window.dispatchEvent(new CustomEvent("fizgig-projects-changed"));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">✦</div><div><strong>Fizgig</strong><span>LoRA Training Studio</span></div></div>
        <nav>{nav.map(([icon, label, to]) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}><i className={`ti ${icon} step`} aria-hidden="true" />{label}</NavLink>)}</nav>
        <div className="sidebar-spacer" />
        {project
          ? <button className="nav-item transfer-button export-project-button" type="button" onClick={() => setTransferMode("export")} title="Choose what to include in the Fizgig project archive"><i className="ti ti-package-export nav-action-icon" aria-hidden="true" />Export Project</button>
          : <button className="nav-item transfer-button" type="button" onClick={() => setTransferMode("import")} title="Inspect and selectively import a Fizgig project archive"><i className="ti ti-package-import nav-action-icon" aria-hidden="true" />Import Project</button>}
        {project && <button className="nav-item close-project-button" onClick={onCloseProject}><i className="ti ti-square-rounded-x nav-action-icon" aria-hidden="true" />Close Project</button>}
        <NavLink to="/preferences" className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}><i className="ti ti-settings nav-action-icon" aria-hidden="true" />Preferences</NavLink>
        <div className={`status runtime-status ${activity.busy ? "busy" : "idle"}`} title={activity.detail || activity.label}>
          <span className="runtime-ready"><i /> Ready</span>
          <strong>{activity.busy ? "BUSY" : "IDLE"}</strong>
          {activity.busy && <small>{activity.detail || activity.label}</small>}
        </div>
      </aside>
      <main className="content">
        {trainingSetupMissing && <div className="training-model-warning" role="alert">
          <div><strong>{activeTrainingFamily?.name ?? "Training"} models are not configured.</strong><span>Core DiT, text encoder and VAE weights must be configured before launching this training family.</span></div>
          <button className="secondary" type="button" onClick={() => navigate("/preferences#training-models")}>Setup now</button>
        </div>}
        <Routes><Route path="/" element={<StartPage onImportProject={() => setTransferMode("import")} onExportProject={() => setTransferMode("export")} />} /><Route path="/image-prep" element={<ImagePrepWorkbenchPageV6 />} /><Route path="/captions" element={<CaptionsStagePage />} /><Route path="/samples" element={<SamplesPage />} /><Route path="/training" element={<TrainingPageShell />} /><Route path="/preferences" element={<PreferencesPage />} /></Routes>
      </main>
      {notification && <div className={`runtime-global-toast ${notification.tone}`} role="status">{notification.message}</div>}
      {transferMode && <ProjectTransferDialog
        mode={transferMode}
        project={project}
        onClose={() => setTransferMode(null)}
        onImported={openImportedProject}
      />}
    </div>
  );
}
