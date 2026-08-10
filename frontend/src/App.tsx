import { NavLink, Route, Routes } from "react-router-dom";
import { CaptionsPage } from "./pages/CaptionsPage";
import { ImagePrepPage } from "./pages/ImagePrepPage";
import { PreferencesPage } from "./pages/PreferencesPage";
import { SamplesPage } from "./pages/SamplesPage";
import { StartPage } from "./pages/StartPage";
import { TrainingPage } from "./pages/TrainingPage";

const nav = [
  ["1", "Start", "/"],
  ["2", "Image Prep", "/image-prep"],
  ["3", "Captions", "/captions"],
  ["4", "Samples", "/samples"],
  ["5", "Training", "/training"],
];

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">✦</div><div><strong>Fizgig</strong><span>LoRA Training Studio</span></div></div>
        <nav>{nav.map(([n, label, to]) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}><span className="step">{n}</span>{label}</NavLink>)}</nav>
        <div className="sidebar-spacer" />
        <NavLink to="/preferences" className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>⚙ Preferences</NavLink>
        <div className="status"><i /> Ready</div>
      </aside>
      <main className="content"><Routes><Route path="/" element={<StartPage />} /><Route path="/image-prep" element={<ImagePrepPage />} /><Route path="/captions" element={<CaptionsPage />} /><Route path="/samples" element={<SamplesPage />} /><Route path="/training" element={<TrainingPage />} /><Route path="/preferences" element={<PreferencesPage />} /></Routes></main>
    </div>
  );
}
