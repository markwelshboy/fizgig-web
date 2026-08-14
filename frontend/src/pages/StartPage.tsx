import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createProject, createProjectRevision, getProjectRevision, importProjectArchive, inspectDataset, listProjects, projectExportUrl, uploadSourceArchive, type DatasetInfo, type ProjectInfo } from "../api";
import { useSession } from "../session";

const DISMISSED_RECENTS_KEY = "fizgig.dismissedRecentProjects";
const PROJECT_NAME_ADJECTIVES = ["fine", "bright", "quiet", "swift", "silver", "mellow", "clever", "vivid", "gentle", "lucky", "crisp", "bold", "calm", "happy", "sunny", "brisk", "soft", "wise", "kind", "rapid", "tidy", "steady", "golden", "nimble"];
const PROJECT_NAME_CREATURES = ["unicorn", "otter", "badger", "raven", "heron", "llama", "panda", "fox", "gecko", "falcon", "rabbit", "tiger", "koala", "orca", "finch", "beaver", "lynx", "yak", "wombat", "penguin", "dolphin", "moose", "puffin", "dragon"];
const PROJECT_NAME_THINGS = ["potatoes", "lantern", "meadow", "harbor", "comet", "pebble", "canyon", "orchard", "anchor", "rocket", "forest", "island", "thunder", "walnut", "sunset", "river", "maple", "compass", "pocket", "castle", "cloud", "acorn", "ember", "garden"];
function readDismissedRecents() { try { const value = JSON.parse(localStorage.getItem(DISMISSED_RECENTS_KEY) || "[]"); return new Set<string>(Array.isArray(value) ? value : []); } catch { return new Set<string>(); } }
function workingDatasetCount(project: ProjectInfo) { return project.dataset_revisions.filter((entry) => entry.model_family !== "generic").length; }
function randomItem(values: string[]) { return values[Math.floor(Math.random() * values.length)]; }
function makeProjectName(existing: Set<string> = new Set()) {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const candidate = `${randomItem(PROJECT_NAME_ADJECTIVES)}_${randomItem(PROJECT_NAME_CREATURES)}_${randomItem(PROJECT_NAME_THINGS)}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${randomItem(PROJECT_NAME_ADJECTIVES)}_${randomItem(PROJECT_NAME_CREATURES)}_${randomItem(PROJECT_NAME_THINGS)}${Math.floor(Math.random() * 1000)}`;
}

function wildcardMatches(filename: string, pattern: string) {
  const value = pattern.trim() || "*";
  const escaped = value.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try { return new RegExp(`^${escaped}$`, "i").test(filename); }
  catch { return filename.toLowerCase().includes(value.toLowerCase()); }
}

export function StartPage() {
  const navigate = useNavigate();
  const sourceArchiveInput = useRef<HTMLInputElement | null>(null);
  const projectArchiveInput = useRef<HTMLInputElement | null>(null);
  const projectNameInput = useRef<HTMLInputElement | null>(null);
  const { project, setProject, revision, setRevision, setRun, dataset, setDataset, modelFamily, setModelFamily, triggerWord, setTriggerWord } = useSession();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [dismissedRecents, setDismissedRecents] = useState<Set<string>>(() => readDismissedRecents());
  const [projectName, setProjectName] = useState(() => makeProjectName());
  const [projectNameEditable, setProjectNameEditable] = useState(false);
  const [projectDescription, setProjectDescription] = useState("");
  const [sourcePath, setSourcePath] = useState("/workspace/sources/5H1VY");
  const [sourceInfo, setSourceInfo] = useState<DatasetInfo | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState("");
  const [expandableSourceImages, setExpandableSourceImages] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [transferMessage, setTransferMessage] = useState("");

  useEffect(() => {
    listProjects().then((items) => {
      setProjects(items);
      const existingNames = new Set(items.map((item) => item.name.trim().toLowerCase()));
      setProjectName((current) => existingNames.has(current.trim().toLowerCase()) ? makeProjectName(existingNames) : current);
    }).catch(() => undefined);
  }, []);
  const recentProjects = useMemo(() => projects.filter((item) => !dismissedRecents.has(item.id)), [projects, dismissedRecents]);
  const duplicateName = projectName.trim() && projects.some((item) => item.name.trim().toLowerCase() === projectName.trim().toLowerCase());
  const selectedImages = sourceInfo?.images.filter((image) => selected.has(image.filename)) ?? [];
  const selectedCaptionCount = selectedImages.filter((image) => image.has_caption).length;
  const visibleSourceImages = useMemo(() => sourceInfo?.images.filter((image) => wildcardMatches(image.filename, sourceFilter)) ?? [], [sourceInfo, sourceFilter]);

  function persistDismissed(next: Set<string>) { setDismissedRecents(next); localStorage.setItem(DISMISSED_RECENTS_KEY, JSON.stringify([...next])); }
  function restoreRecent(projectId: string) { if (!dismissedRecents.has(projectId)) return; const next = new Set(dismissedRecents); next.delete(projectId); persistDismissed(next); }
  function dismissRecent(projectId: string) { const next = new Set(dismissedRecents); next.add(projectId); persistDismissed(next); }
  function clearRecentProjects() { persistDismissed(new Set(projects.map((item) => item.id))); }
  function enableProjectNameEditing() {
    setProjectNameEditable(true);
    requestAnimationFrame(() => {
      projectNameInput.current?.focus();
      projectNameInput.current?.select();
    });
  }

  function rememberSourceAspect(filename: string, width: number, height: number) {
    const ratio = width / Math.max(1, height);
    const canExpand = Math.abs(ratio - 1) > 0.03;
    setExpandableSourceImages((current) => {
      if (current.has(filename) === canExpand) return current;
      const next = new Set(current);
      if (canExpand) next.add(filename); else next.delete(filename);
      return next;
    });
  }

  function selectVisible() {
    setSelected((current) => {
      const next = new Set(current);
      visibleSourceImages.forEach((image) => next.add(image.filename));
      return next;
    });
  }

  function deselectVisible() {
    setSelected((current) => {
      const next = new Set(current);
      visibleSourceImages.forEach((image) => next.delete(image.filename));
      return next;
    });
  }

  async function inspectSource() {
    setLoading(true); setError(""); setTransferMessage("");
    try { const info = await inspectDataset(sourcePath); setSourceInfo(info); setSelected(new Set(info.images.map((image) => image.filename))); setSourceFilter(""); setExpandableSourceImages(new Set()); }
    catch (err) { setSourceInfo(null); setSelected(new Set()); setSourceFilter(""); setExpandableSourceImages(new Set()); setError(err instanceof Error ? err.message : "Unable to inspect source assets"); }
    finally { setLoading(false); }
  }

  async function onSourceArchive(file: File) {
    setLoading(true); setError(""); setTransferMessage(`Uploading ${file.name}…`);
    try {
      const imported = await uploadSourceArchive(sourcePath, file);
      setSourcePath(imported.path);
      const info = await inspectDataset(imported.path);
      setSourceInfo(info);
      setSelected(new Set(info.images.map((image) => image.filename)));
      setSourceFilter("");
      setExpandableSourceImages(new Set());
      setTransferMessage(`Imported ${imported.image_count} images and ${imported.caption_count} captions from ${file.name}.`);
    } catch (err) {
      setTransferMessage("");
      setError(err instanceof Error ? err.message : "Unable to import source archive");
    } finally {
      setLoading(false);
      if (sourceArchiveInput.current) sourceArchiveInput.current.value = "";
    }
  }

  async function onProjectArchive(file: File) {
    setLoading(true); setError(""); setTransferMessage(`Importing ${file.name}…`);
    try {
      const imported = await importProjectArchive(file);
      const refreshedProjects = await listProjects();
      setProjects(refreshedProjects);
      setTransferMessage(`Imported project ${imported.name}.`);
      await openProject(refreshedProjects.find((item) => item.id === imported.id) ?? imported);
    } catch (err) {
      setTransferMessage("");
      setError(err instanceof Error ? err.message : "Unable to import project archive");
    } finally {
      setLoading(false);
      if (projectArchiveInput.current) projectArchiveInput.current.value = "";
    }
  }

  async function onCreateProject() {
    if (!projectName.trim()) { setError("Give the project a name."); return; }
    if (duplicateName) { setError(`A project named “${projectName.trim()}” already exists. Use a distinct project name.`); return; }
    if (!sourceInfo) { setError("Load the source training assets before creating the project."); return; }
    if (!selected.size) { setError("Select at least one source asset for the project."); return; }
    setLoading(true); setError(""); setTransferMessage("");
    try {
      const result = await createProject({ name: projectName.trim(), source_path: sourcePath, trigger_word: triggerWord, description: projectDescription.trim(), selected_filenames: [...selected] });
      restoreRecent(result.project.id); setProject(result.project); setRevision(result.revision); setRun(null);
      setDataset(await inspectDataset(result.revision.files_path)); setProjects(await listProjects());
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to create project"); } finally { setLoading(false); }
  }

  async function openProject(item: ProjectInfo) {
    setLoading(true); setError("");
    try {
      restoreRecent(item.id); setProject(item); setRun(null); setTriggerWord(item.trigger_word || triggerWord);
      const current = item.dataset_revisions.find((entry) => entry.id === item.current_dataset_revision) ?? item.dataset_revisions[item.dataset_revisions.length - 1];
      if (current) { if (current.model_family === "krea2" || current.model_family === "klein") setModelFamily(current.model_family); const fullRevision = await getProjectRevision(item.id, current.id); setRevision(fullRevision); setDataset(await inspectDataset(fullRevision.files_path)); }
      else { setRevision(null); setDataset(null); }
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to open project"); } finally { setLoading(false); }
  }

  async function ensureTrainingRevision(destination: "/image-prep" | "/captions") {
    if (!project) return;
    setLoading(true); setError("");
    try {
      let activeRevision = revision;
      if (!activeRevision || activeRevision.model_family !== modelFamily) {
        activeRevision = await createProjectRevision(project.id, { name: `${modelFamily === "krea2" ? "Krea 2" : "Klein"} project assets`, model_family: modelFamily, import_id: project.current_import });
        setRevision(activeRevision); setDataset(await inspectDataset(activeRevision.files_path));
        const refreshed = (await listProjects()).find((item) => item.id === project.id); if (refreshed) setProject(refreshed);
      }
      navigate(destination);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to prepare project assets"); } finally { setLoading(false); }
  }

  const importedCaptionCount = dataset?.caption_count ?? 0;
  const importedImageCount = dataset?.image_count ?? 0;
  const needCaptionCount = Math.max(0, importedImageCount - importedCaptionCount);

  return <div className="stack">
    <header className="page-header"><div><p className="eyebrow">Projects</p><h1>{project ? project.name : "Create or Open a Training Project"}</h1><p className="muted">Source training assets remain golden and untouched. A project contains only the assets you deliberately select, with provenance retained back to their source.</p></div>{project && <div className="project-identity"><span>Project ID</span><strong>{project.id}</strong></div>}</header>

    {!project && <>
      <div className="project-entry-grid">
        <section className="panel create-project-panel">
          <div className="project-create-heading"><div className="card-title">Create Project</div><p className="muted">Create a new training project from deliberately selected source assets.</p></div>

          <div className="project-create-subpanel stack">
            <div><div className="card-title">Project Basics</div><p className="muted">A generated project name is ready to use. Edit it only if you want something more memorable.</p></div>
            <div className="form-row">
              <label>Project name
                <div className="project-name-row">
                  <input ref={projectNameInput} value={projectName} readOnly={!projectNameEditable} onChange={(e) => { setProjectName(e.target.value); setError(""); }} spellCheck={false} />
                  <button type="button" className="project-name-edit-pill" title="Edit Project Name" onClick={enableProjectNameEditing}>Edit</button>
                </div>
                {duplicateName && <small className="status-suspect">A project with this display name already exists.</small>}
              </label>
              <label>Trigger word<input value={triggerWord} onChange={(e) => setTriggerWord(e.target.value)} /></label>
            </div>
            <label>Project Description (optional)<textarea value={projectDescription} onChange={(e) => setProjectDescription(e.target.value)} rows={3} placeholder="What is this training project for?" /></label>
          </div>

          <div className="project-create-subpanel stack project-source-panel">
            <div className="prep-section-heading"><div><div className="card-title">Source Training Assets</div><p className="muted">Golden source material. Fizgig reads from this location but never edits it.</p></div></div>
            <div className="source-path-block">
              <div className="source-directory-label">Source directory</div>
              <input aria-label="Source directory" value={sourcePath} onChange={(e) => { setSourcePath(e.target.value); setSourceInfo(null); setSelected(new Set()); setSourceFilter(""); setExpandableSourceImages(new Set()); setTransferMessage(""); }} />
              <button type="button" className="secondary source-upload-button" disabled={loading} onClick={() => sourceArchiveInput.current?.click()}>{loading ? "Working…" : "Upload Zip/Tar Archive"}</button>
              <input ref={sourceArchiveInput} className="visually-hidden-file" type="file" accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/gzip,application/x-tar" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void onSourceArchive(file); }} />
              <button type="button" className="secondary source-load-button" onClick={inspectSource} disabled={loading}>{loading ? "Loading…" : "Load Source Directory"}</button>
            </div>
            {sourceInfo && <>
              <div className="source-selection-toolbar">
                <label className="source-filter-label">Filter filenames
                  <div className="source-filter-shell"><span className={sourceFilter ? "hidden-star" : "filter-star"}>*</span><input value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} placeholder="" spellCheck={false} /></div>
                  <small>Wildcards: <code>*john*</code>, <code>portrait_??.png</code>. Empty means <code>*</code>.</small>
                </label>
                <div className="source-filter-status"><strong>{visibleSourceImages.length}</strong><span>visible</span><strong>{selected.size}</strong><span>selected of {sourceInfo.image_count}</span></div>
                <div className="actions source-bulk-actions"><button className="secondary" onClick={selectVisible} disabled={!visibleSourceImages.length}>Select all visible</button><button className="secondary" onClick={deselectVisible} disabled={!visibleSourceImages.length}>Deselect all visible</button></div>
              </div>
              <div className="prep-section-heading"><div><strong>Available source assets</strong><span className="muted"> {visibleSourceImages.length}{visibleSourceImages.length !== sourceInfo.image_count ? ` of ${sourceInfo.image_count}` : ""}</span></div></div>
              {visibleSourceImages.length > 0 ? <div className="source-selection-grid">{visibleSourceImages.map((image) => <button type="button" key={image.filename} className={`prep-image-card source-selection-card ${selected.has(image.filename) ? "selected" : "excluded"}`} onClick={() => setSelected((current) => { const next = new Set(current); next.has(image.filename) ? next.delete(image.filename) : next.add(image.filename); return next; })}><div className={`prep-image-wrap source-selection-image ${expandableSourceImages.has(image.filename) ? "can-expand" : ""}`}><img src={image.image_url} alt={image.filename} onLoad={(event) => rememberSourceAspect(image.filename, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />{image.has_caption && <span className="caption-badge" title={image.caption}>C</span>}<span className="selection-check">{selected.has(image.filename) ? "✓" : ""}</span></div><div className="prep-image-meta"><strong title={image.filename}>{image.filename}</strong></div></button>)}</div> : <div className="notice">No source assets match <strong>{sourceFilter || "*"}</strong>.</div>}
              <div className="summary-ledger source-accounting-ledger">
                <div><span>Selected Project Assets</span><strong>{selected.size}</strong><small>of {sourceInfo.image_count} available source images</small></div>
                <div><span>Associated Captions</span><strong>{selectedCaptionCount}</strong><small>matching captions in selected assets</small></div>
                <div><span>Images Requiring Captioning</span><strong>{Math.max(0, selected.size - selectedCaptionCount)}</strong><small>selected images without a caption</small></div>
              </div>
            </>}
            <div className="notice">Creating the project makes an immutable provenance snapshot of the selected assets. Unselected source material does not become a project asset.</div>
          </div>

          <div className="actions project-create-actions"><button className="primary" onClick={onCreateProject} disabled={loading || Boolean(duplicateName) || !sourceInfo || selected.size === 0}>{loading ? "Creating…" : "Create Project"}</button></div>
        </section>

        <section className="panel import-project-panel">
          <div><div className="card-title">Import Project</div><p className="muted">Open a complete Fizgig project archive from another pod.</p></div>
          <button type="button" className="secondary project-import-button" disabled={loading} onClick={() => projectArchiveInput.current?.click()}>{loading ? "Working…" : "Open Project Archive"}</button>
          <input ref={projectArchiveInput} className="visually-hidden-file" type="file" accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/gzip,application/x-tar" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void onProjectArchive(file); }} />
        </section>
      </div>
    </>}

    {!project && recentProjects.length > 0 && <section className="panel stack"><div className="prep-section-heading"><div><div className="card-title">Recent Projects</div><p className="muted">Project ID is the immutable provenance key. Removing an item only clears it from this browser's recent list.</p></div><button className="secondary" onClick={clearRecentProjects}>Clear recent projects</button></div><div className="project-list">{recentProjects.map((item) => { const count = workingDatasetCount(item); return <div className="project-row-shell" key={item.id}><button className="project-row" onClick={() => openProject(item)} disabled={loading}><span><strong>{item.name}</strong><small className="project-id-line">ID: {item.id}</small><small>{item.external_source.path}</small></span><span className="muted">{count} training path{count === 1 ? "" : "s"} · {item.runs.length} runs</span></button><button className="recent-remove" onClick={() => dismissRecent(item.id)} title="Remove from recent projects">×</button></div>; })}</div></section>}
    {!project && projects.length > 0 && recentProjects.length === 0 && <section className="panel"><p className="muted">Recent project list is cleared for this browser. Existing project files remain under the configured projects directory.</p><button className="secondary" onClick={() => persistDismissed(new Set())}>Show projects again</button></section>}

    {project && <>
      <section className="panel stack project-source-panel">
        <div className="prep-section-heading"><div className="card-title">Project Source</div><a className="secondary archive-download-link" href={projectExportUrl(project.id)}>Download Project Archive</a></div>
        <div className="summary-ledger project-source-ledger">
          <div><span>Project ID</span><strong>{project.id}</strong><small>immutable provenance key</small></div>
          <div><span>Source Training Assets</span><strong>{project.external_source.path}</strong><small>golden source · read-only to Fizgig</small></div>
        </div>
        {dataset && <div className="summary-ledger source-accounting-ledger"><div><span>Project Images</span><strong>{importedImageCount}</strong><small>selected from golden source</small></div><div><span>Associated Captions</span><strong>{importedCaptionCount}</strong><small>matching imported captions</small></div><div><span>Images Requiring Captioning</span><strong>{needCaptionCount}</strong><small>no associated caption</small></div></div>}
        <details className="project-technical-details">
          <summary>Technical project details</summary>
          <div className="summary-ledger project-technical-ledger">
            <div><span>Import snapshot</span><strong>{project.current_import}</strong><small>{project.imports.find((i) => i.id === project.current_import)?.image_count ?? importedImageCount} selected project assets</small></div>
            <div><span>Working dataset revision</span><strong>{revision?.id ?? "Initial"}</strong><small>{revision?.name ?? "training direction not yet selected"}</small></div>
          </div>
        </details>
        <div className="notice success">Source assets remain untouched. From here onward Fizgig works with project-owned assets and records their provenance.</div>
      </section>
      <section className="panel stack">
        <div><div className="card-title">Training Direction</div><p className="muted">Choose how these project assets will eventually become a training dataset.</p></div>
        <div className="model-grid training-direction-grid"><button className={`model-card ${modelFamily === "krea2" ? "selected" : ""}`} onClick={() => setModelFamily("krea2")}><strong>Krea 2</strong><span>Per-image loss, adaptive LR, auto-recaption</span></button><button className={`model-card ${modelFamily === "klein" ? "selected" : ""}`} onClick={() => setModelFamily("klein")}><strong>Klein</strong><span>Shared project-asset workflow with Klein training configuration</span></button></div>
        <div className="actions split-actions"><button className="secondary" onClick={() => ensureTrainingRevision("/captions")} disabled={loading}>{loading ? "Preparing…" : "Skip to Captioning"}</button><button className="primary" onClick={() => ensureTrainingRevision("/image-prep")} disabled={loading}>{loading ? "Preparing…" : "Continue to Image Prep"}</button></div>
      </section>
    </>}
    {transferMessage && <div className="notice success">{transferMessage}</div>}
    {error && <div className="notice error">{error}</div>}
  </div>;
}
