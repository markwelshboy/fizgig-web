import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { CaptionsPage } from "./pages/CaptionsPage";
import { ImagePrepWorkbenchPageV2 } from "./pages/ImagePrepWorkbenchPageV2";
import { PreferencesPage } from "./pages/PreferencesPage";
import { SamplesPage } from "./pages/SamplesPage";
import { StartPage } from "./pages/StartPage";
import { TrainingPage } from "./pages/TrainingPage";
import { useSession } from "./session";

const nav = [
  ["1", "Start", "/"],
  ["2", "Image Prep", "/image-prep"],
  ["3", "Captions", "/captions"],
  ["4", "Samples", "/samples"],
  ["5", "Training", "/training"],
];

export default function App() {
  const navigate = useNavigate();
  const { project, closeProject } = useSession();

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
        {project && <button className="nav-item close-project-button" onClick={onCloseProject}><span className="step">×</span>Close Project</button>}
        <NavLink to="/preferences" className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>⚙ Preferences</NavLink>
        <div className="status"><i /> Ready</div>
      </aside>
      <main className="content"><Routes><Route path="/" element={<StartPage />} /><Route path="/image-prep" element={<ImagePrepWorkbenchPageV2 />} /><Route path="/captions" element={<CaptionsPage />} /><Route path="/samples" element={<SamplesPage />} /><Route path="/training" element={<TrainingPage />} /><Route path="/preferences" element={<PreferencesPage />} /></Routes></main>
    </div>
  );
}
