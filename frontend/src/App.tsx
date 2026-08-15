import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  getActivityStatus,
  subscribeLocalActivity,
  subscribeRuntimeNotifications,
  type ActivityStatus,
  type RuntimeNotification,
} from "./activity-api";
import { CaptionsStagePage } from "./pages/CaptionsStagePage";
import { ImagePrepWorkbenchPageV5 } from "./pages/ImagePrepWorkbenchPageV5";
import { PreferencesPage } from "./pages/PreferencesPage";
import { SamplesPage } from "./pages/SamplesPage";
import { StartPage } from "./pages/StartPage";
import { TrainingPageShell } from "./pages/TrainingPageShell";
import { useSession } from "./session";
import { getTrainingModelState, type TrainingModelState } from "./training-models-api";

const nav = [
  ["1", "Start", "/"],
  ["2", "Image Prep", "/image-prep"],
  ["3", "Captions", "/captions"],
  ["4", "Sampling", "/samples"],
  ["5", "Training", "/training"],
];

const IDLE: ActivityStatus = { busy: false, label: "Idle", detail: "", active_count: 0, elapsed_seconds: 0 };

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const { project, revision, modelFamily, closeProject } = useSession();
  const [backendActivity, setBackendActivity] = useState<ActivityStatus>(IDLE);
  const [localActivity, setLocalActivity] = useState<ActivityStatus>(IDLE);
  const [notification, setNotification] = useState<RuntimeNotification | null>(null);
  const [trainingModels, setTrainingModels] = useState<TrainingModelState | null>(null);
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">✦</div><div><strong>Fizgig</strong><span>LoRA Training Studio</span></div></div>
        <nav>{nav.map(([n, label, to]) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}><span className="step">{n}</span>{label}</NavLink>)}</nav>
        <div className="sidebar-spacer" />
        {project && <a className="nav-item export-project-button" href={`/api/projects/${encodeURIComponent(project.id)}/export`} title="Download the complete portable Fizgig project archive"><span className="step">⇩</span>Export Project</a>}
        {project && <button className="nav-item close-project-button" onClick={onCloseProject}><span className="step">×</span>Close Project</button>}
        <NavLink to="/preferences" className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>⚙ Preferences</NavLink>
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
        <Routes><Route path="/" element={<StartPage />} /><Route path="/image-prep" element={<ImagePrepWorkbenchPageV5 />} /><Route path="/captions" element={<CaptionsStagePage />} /><Route path="/samples" element={<SamplesPage />} /><Route path="/training" element={<TrainingPageShell />} /><Route path="/preferences" element={<PreferencesPage />} /></Routes>
      </main>
      {notification && <div className={`runtime-global-toast ${notification.tone}`} role="status">{notification.message}</div>}
    </div>
  );
}
