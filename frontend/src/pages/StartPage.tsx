import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createProject,
  createProjectRevision,
  inspectDataset,
  listProjects,
  type ProjectInfo,
} from "../api";
import { useSession } from "../session";

export function StartPage() {
  const navigate = useNavigate();
  const {
    project,
    setProject,
    revision,
    setRevision,
    setRun,
    dataset,
    setDataset,
    modelFamily,
    setModelFamily,
    triggerWord,
    setTriggerWord,
  } = useSession();

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectName, setProjectName] = useState("");
  const [sourcePath, setSourcePath] = useState("/workspace/datasets/sH1VX");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listProjects().then(setProjects).catch(() => undefined);
  }, []);

  async function onCreateProject() {
    if (!projectName.trim()) {
      setError("Give the project a name.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await createProject({
        name: projectName,
        source_path: sourcePath,
        trigger_word: triggerWord,
      });
      setProject(result.project);
      setRevision(result.revision);
      setRun(null);
      setDataset(await inspectDataset(result.revision.files_path));
      setProjects(await listProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create project");
    } finally {
      setLoading(false);
    }
  }

  async function openProject(item: ProjectInfo) {
    setLoading(true);
    setError("");
    try {
      setProject(item);
      setRun(null);
      setTriggerWord(item.trigger_word || triggerWord);
      const current = item.dataset_revisions.find((entry) => entry.id === item.current_dataset_revision)
        ?? item.dataset_revisions[item.dataset_revisions.length - 1];
      if (current) {
        if (current.model_family === "krea2" || current.model_family === "klein") {
          setModelFamily(current.model_family);
        }
        setRevision(null);
        setDataset(await inspectDataset(current.path));
      } else {
        setDataset(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open project");
    } finally {
      setLoading(false);
    }
  }

  async function continueToPrep() {
    if (!project) return;
    setLoading(true);
    setError("");
    try {
      let activeRevision = revision;
      if (!activeRevision || activeRevision.model_family !== modelFamily) {
        activeRevision = await createProjectRevision(project.id, {
          name: `${modelFamily === "krea2" ? "Krea 2" : "Klein"} working dataset`,
          model_family: modelFamily,
          import_id: project.current_import,
        });
        setRevision(activeRevision);
        setDataset(await inspectDataset(activeRevision.files_path));
        const refreshed = (await listProjects()).find((item) => item.id === project.id);
        if (refreshed) setProject(refreshed);
      }
      navigate("/image-prep");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to prepare working dataset");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Projects</p>
          <h1>{project ? project.name : "Create or Open a Training Project"}</h1>
          <p className="muted">
            Your external dataset remains the canonical source. Fizgig Web snapshots it for reproducibility and works only on project-owned scratch copies.
          </p>
        </div>
        {project && <div className="badge">{project.id}</div>}
      </header>

      {!project && (
        <section className="panel stack">
          <div className="card-title">New Project</div>
          <div className="form-row">
            <label>Project name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="sH1VX identity experiments" /></label>
            <label>Trigger word<input value={triggerWord} onChange={(event) => setTriggerWord(event.target.value)} /></label>
          </div>
          <label>External source dataset<input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} /></label>
          <div className="notice">
            The source folder is never modified. Creating a project makes a frozen import snapshot inside the project so every experiment can be reproduced later.
          </div>
          <div className="actions"><button className="primary" onClick={onCreateProject} disabled={loading}>{loading ? "Creating…" : "Create Project"}</button></div>
        </section>
      )}

      {!project && projects.length > 0 && (
        <section className="panel stack">
          <div className="card-title">Recent Projects</div>
          <div className="project-list">
            {projects.map((item) => (
              <button className="project-row" key={item.id} onClick={() => openProject(item)} disabled={loading}>
                <span><strong>{item.name}</strong><small>{item.external_source.path}</small></span>
                <span className="muted">{item.dataset_revisions.length} datasets · {item.runs.length} runs</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {error && <div className="notice error">{error}</div>}

      {project && (
        <>
          <section className="panel stack">
            <div className="card-title">Project Source</div>
            <div className="dataset-summary">
              <span><strong>External</strong> {project.external_source.path}</span>
              <span><strong>Read-only to Fizgig Web</strong></span>
              <span><strong>{project.imports[0]?.image_count ?? 0}</strong> imported images</span>
            </div>
            {dataset && (
              <>
                <div className="thumb-grid dataset-preview">
                  {dataset.images.slice(0, 8).map((image) => <div className="thumb" key={image.filename}><img src={image.image_url} alt={image.filename} /></div>)}
                </div>
                <div className="dataset-summary">
                  <span><strong>{dataset.image_count}</strong> working images</span>
                  <span><strong>{dataset.caption_count}</strong> captioned</span>
                  <span className={dataset.missing_caption_count ? "status-suspect" : "status-good"}><strong>{dataset.missing_caption_count}</strong> missing captions</span>
                </div>
              </>
            )}
            <div className="actions"><button className="secondary" onClick={() => { setProject(null); setRevision(null); setDataset(null); setRun(null); }}>Switch Project</button></div>
          </section>

          <section className="panel stack">
            <div className="card-title">Target Model</div>
            <p className="muted">Image Prep gets its own model-specific scratch dataset. Crops, resizes, new face crops, exposure fixes, and caption rewrites never flow back into the external source.</p>
            <div className="grid-3">
              <button className={`model-card ${modelFamily === "krea2" ? "selected" : ""}`} onClick={() => setModelFamily("krea2")}><strong>Krea 2 <span className="badge">Recommended</span></strong><small>Per-image loss intelligence and auto-recaptioning.</small></button>
              <button className={`model-card ${modelFamily === "klein" ? "selected" : ""}`} onClick={() => setModelFamily("klein")}><strong>Klein 9B</strong><small>Shares the same project, prep, caption, and run-history model.</small></button>
              <div className="model-card"><strong>More families later</strong><small>Each can derive its own training geometry from the same external source.</small></div>
            </div>
            <div className="actions"><button className="primary" onClick={continueToPrep} disabled={loading}>{loading ? "Preparing…" : `Create ${modelFamily === "krea2" ? "Krea 2" : "Klein"} Working Dataset →`}</button></div>
          </section>
        </>
      )}
    </div>
  );
}
