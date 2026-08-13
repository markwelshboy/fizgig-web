import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
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
import { TrainingPage } from "./pages/TrainingPage";
import { useSession } from "./session";

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
  const { project, closeProject } = useSession();
  const [backendActivity, setBackendActivity] = useState<ActivityStatus>(IDLE);
  const [localActivity, setLocalActivity] = useState<ActivityStatus>(IDLE);
  const [notification, setNotification] = useState<RuntimeNotification | null>(null);
  const activity = localActivity.busy ? localActivity : backendActivity;

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
      <main className="content"><Routes><Route path="/" element={<StartPage />} /><Route path="/image-prep" element={<ImagePrepWorkbenchPageV5 />} /><Route path="/captions" element={<CaptionsStagePage />} /><Route path="/samples" element={<SamplesPage />} /><Route path="/training" element={<TrainingPage />} /><Route path="/preferences" element={<PreferencesPage />} /></Routes></main>
      {notification && <div className={`runtime-global-toast ${notification.tone}`} role="status">{notification.message}</div>}
    </div>
  );
}
