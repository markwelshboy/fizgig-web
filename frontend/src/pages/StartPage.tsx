import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createProject, createProjectRevision, getProjectRevision, inspectDataset, listProjects, type ProjectInfo } from "../api";
import { useSession } from "../session";

const DISMISSED_RECENTS_KEY = "fizgig.dismissedRecentProjects";

function readDismissedRecents() {
  try {
    const value = JSON.parse(localStorage.getItem(DISMISSED_RECENTS_KEY) || "[]");
    return new Set<string>(Array.isArray(value) ? value : []);
  } catch {
    return new Set<string>();
  }
}

function workingDatasetCount(project: ProjectInfo) {
  return project.dataset_revisions.filter((entry) => entry.model_family !== "generic").length;
}

export function StartPage() {
  const navigate = useNavigate();
  const { project, setProject, revision, setRevision, setRun, dataset, setDataset, modelFamily, setModelFamily, triggerWord, setTriggerWord } = useSession();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [dismissedRecents, setDismissedRecents] = useState<Set<string>>(() => readDismissedRecents());
  const [projectName, setProjectName] = useState("");
  const [sourcePath, setSourcePath] = useState("/workspace/datasets/sH1VX");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { listProjects().then(setProjects).catch(() => undefined); }, []);
  const recentProjects = useMemo(() => projects.filter((item) => !dismissedRecents.has(item.id)), [projects, dismissedRecents]);
  const duplicateName = projectName.trim() && projects.some((item) => item.name.trim().toLowerCase() === projectName.trim().toLowerCase());

  function persistDismissed(next: Set<string>) {
    setDismissedRecents(next);
    localStorage.setItem(DISMISSED_RECENTS_KEY, JSON.stringify([...next]));
  }

  function restoreRecent(projectId: string) {
    if (!dismissedRecents.has(projectId)) return;
    const next = new Set(dismissedRecents); next.delete(projectId); persistDismissed(next);
  }

  function dismissRecent(projectId: string) {
    const next = new Set(dismissedRecents); next.add(projectId); persistDismissed(next);
  }

  function clearRecentProjects() {
    persistDismissed(new Set(projects.map((item) => item.id)));
  }

  async function onCreateProject() {
    if (!projectName.trim()) { setError("Give the project a name."); return; }
    if (duplicateName) { setError(`A project named “${projectName.trim()}” already exists. Use a distinct experiment/project name.`); return; }
    setLoading(true); setError("");
    try {
      const result = await createProject({ name: projectName, source_path: sourcePath, trigger_word: triggerWord });
      restoreRecent(result.project.id);
      setProject(result.project); setRevision(result.revision); setRun(null); setDataset(await inspectDataset(result.revision.files_path)); setProjects(await listProjects());
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to create project"); } finally { setLoading(false); }
  }

  async function openProject(item: ProjectInfo) {
    setLoading(true); setError("");
    try {
      restoreRecent(item.id);
      setProject(item); setRun(null); setTriggerWord(item.trigger_word || triggerWord);
      const current = item.dataset_revisions.find((entry) => entry.id === item.current_dataset_revision) ?? item.dataset_revisions[item.dataset_revisions.length - 1];
      if (current) {
        if (current.model_family === "krea2" || current.model_family === "klein") setModelFamily(current.model_family);
        const fullRevision = await getProjectRevision(item.id, current.id);
        setRevision(fullRevision);
        setDataset(await inspectDataset(fullRevision.files_path));
      } else { setRevision(null); setDataset(null); }
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to open project"); } finally { setLoading(false); }
  }

  async function continueToPrep() {
    if (!project) return;
    setLoading(true); setError("");
    try {
      let activeRevision = revision;
      if (!activeRevision || activeRevision.model_family !== modelFamily) {
        activeRevision = await createProjectRevision(project.id, { name: `${modelFamily === "krea2" ? "Krea 2" : "Klein"} working dataset`, model_family: modelFamily, import_id: project.current_import });
        setRevision(activeRevision); setDataset(await inspectDataset(activeRevision.files_path));
        const refreshed = (await listProjects()).find((item) => item.id === project.id); if (refreshed) setProject(refreshed);
      }
      navigate("/image-prep");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to prepare working dataset"); } finally { setLoading(false); }
  }

  return <div className="stack">
    <header className="page-header"><div><p className="eyebrow">Projects</p><h1>{project ? project.name : "Create or Open a Training Project"}</h1><p className="muted">Your external dataset remains the canonical source. Fizgig Web snapshots it for reproducibility and works only on project-owned scratch copies.</p></div>{project && <div className="project-identity"><span>Project ID</span><strong>{project.id}</strong></div>}</header>
    {!project && <section className="panel stack"><div className="card-title">New Project</div><div className="form-row"><label>Project name<input value={projectName} onChange={(event) => { setProjectName(event.target.value); setError(""); }} placeholder="sH1VX identity experiments" />{duplicateName && <small className="status-suspect">A project with this display name already exists.</small>}</label><label>Trigger word<input value={triggerWord} onChange={(event) => setTriggerWord(event.target.value)} /></label></div><label>External source dataset<input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} /></label><div className="notice">The source folder is never modified. Creating a project makes a frozen import snapshot inside the project so every experiment can be reproduced later.</div><div className="actions"><button className="primary" onClick={onCreateProject} disabled={loading || Boolean(duplicateName)}>{loading ? "Creating…" : "Create Project"}</button></div></section>}
    {!project && recentProjects.length > 0 && <section className="panel stack"><div className="prep-section-heading"><div><div className="card-title">Recent Projects</div><p className="muted">Project ID is the immutable provenance key. Removing an item only clears it from this browser's recent list.</p></div><button className="secondary" onClick={clearRecentProjects}>Clear recent projects</button></div><div className="project-list">{recentProjects.map((item) => { const count = workingDatasetCount(item); return <div className="project-row-shell" key={item.id}><button className="project-row" onClick={() => openProject(item)} disabled={loading}><span><strong>{item.name}</strong><small className="project-id-line">ID: {item.id}</small><small>{item.external_source.path}</small></span><span className="muted">{count} working dataset{count === 1 ? "" : "s"} · {item.runs.length} runs</span></button><button className="recent-remove" onClick={() => dismissRecent(item.id)} title="Remove from recent projects" aria-label={`Remove ${item.name} (${item.id}) from recent projects`}>×</button></div>; })}</div></section>}
    {!project && projects.length > 0 && recentProjects.length === 0 && <section className="panel"><p className="muted">Recent project list is cleared for this browser. Existing project files remain under the configured projects directory.</p><button className="secondary" onClick={() => persistDismissed(new Set())}>Show projects again</button></section>}
    {project && <><section className="panel stack"><div className="card-title">Project Source</div><div className="summary-grid"><div><span>Project ID</span><strong>{project.id}</strong></div><div><span>External canonical source</span><strong>{project.external_source.path}</strong></div><div><span>Frozen import</span><strong>{project.current_import}</strong></div><div><span>Working revision</span><strong>{revision?.id ?? project.current_dataset_revision ?? "Not selected"}</strong></div></div><div className="notice success">Fizgig Web will not write to the external source. Captions and image changes belong to this project's working revision and history.</div></section><section className="panel stack"><div className="card-title">Training Direction</div><div className="model-grid"><button className={`model-card ${modelFamily === "krea2" ? "selected" : ""}`} onClick={() => setModelFamily("krea2")}><strong>Krea 2</strong><span>Per-image loss, adaptive LR, auto-recaption</span></button><button className={`model-card ${modelFamily === "klein" ? "selected" : ""}`} onClick={() => setModelFamily("klein")}><strong>Klein</strong><span>Shared project/dataset workflow with Klein training configuration</span></button></div>{dataset && <div className="summary-grid"><div><span>Images</span><strong>{dataset.image_count}</strong></div><div><span>Working captions</span><strong>{revision?.assets.filter((asset) => asset.caption.trim()).length ?? 0}</strong></div><div><span>Need captions</span><strong>{revision?.assets.filter((asset) => !asset.caption.trim()).length ?? 0}</strong></div></div>}<div className="actions"><button className="primary" onClick={continueToPrep} disabled={loading}>{loading ? "Preparing…" : "Continue to Image Prep"}</button></div></section></>}
    {error && <div className="notice error">{error}</div>}
  </div>;
}
