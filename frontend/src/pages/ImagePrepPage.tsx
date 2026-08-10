import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createManualCrop,
  getImagePrepState,
  getProjectRevision,
  inspectDataset,
  setAllImageInclusion,
  setAssetImageTransform,
  setGlobalImageTransform,
  setImageInclusion,
  type ImagePrepState,
  type ImageTransform,
} from "../api";
import { useSession } from "../session";

type Filter = "all" | "included" | "excluded";
const ASPECTS = ["16:9", "1:1", "4:5", "5:4", "9:16"];

function aspectNumber(value: string) {
  const [w, h] = value.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

export function ImagePrepPage() {
  const navigate = useNavigate();
  const { project, revision, setRevision, dataset, setDataset, modelFamily } = useSession();
  const [prep, setPrep] = useState<ImagePrepState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [editName, setEditName] = useState("");
  const [globalDraft, setGlobalDraft] = useState<ImageTransform>({});
  const [overrideDraft, setOverrideDraft] = useState<ImageTransform>({});
  const [manualParent, setManualParent] = useState("");
  const [manualAspect, setManualAspect] = useState("1:1");
  const [manualCenterX, setManualCenterX] = useState(0.5);
  const [manualCenterY, setManualCenterY] = useState(0.5);
  const [manualScale, setManualScale] = useState(0.8);
  const [manualDims, setManualDims] = useState({ width: 1, height: 1 });

  useEffect(() => {
    if (!project || !revision) return;
    getImagePrepState(project.id, revision.id).then((state) => {
      setPrep(state);
      setGlobalDraft(state.global_transform || {});
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load image prep state"));
  }, [project, revision]);

  const assets = prep?.assets ?? revision?.assets ?? [];
  const includedAssets = assets.filter((asset) => asset.included !== false);
  const sourceAssets = includedAssets.filter((asset) => asset.asset_kind !== "derived");
  const visible = useMemo(() => assets.filter((asset) => {
    const included = asset.included !== false;
    return filter === "all" || (filter === "included" ? included : !included);
  }), [assets, filter]);
  const transformed = includedAssets;
  const editAsset = transformed.find((asset) => asset.filename === editName);
  const manualAsset = sourceAssets.find((asset) => asset.filename === manualParent) ?? sourceAssets[0];
  const manualImage = dataset?.images.find((image) => image.filename === manualAsset?.filename);

  useEffect(() => {
    if (!manualParent && sourceAssets[0]) setManualParent(sourceAssets[0].filename);
  }, [manualParent, sourceAssets]);

  function toggle(filename: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(filename)) next.delete(filename); else next.add(filename);
      return next;
    });
  }
  function selectVisible() { setSelected(new Set(visible.map((asset) => asset.filename))); }
  function clearSelection() { setSelected(new Set()); }

  async function refreshAll() {
    if (!project || !revision) return;
    const nextRevision = await getProjectRevision(project.id, revision.id);
    setRevision(nextRevision);
    const state = await getImagePrepState(project.id, revision.id);
    setPrep(state);
    setGlobalDraft(state.global_transform || {});
    setDataset(await inspectDataset(nextRevision.files_path));
  }

  async function setIncluded(included: boolean) {
    if (!project || !revision || !selected.size) return;
    setBusy(true); setMessage("");
    try {
      setPrep(await setImageInclusion(project.id, revision.id, [...selected], included));
      await refreshAll();
      setMessage(`${selected.size} image${selected.size === 1 ? "" : "s"} ${included ? "included in" : "excluded from"} the working set.`);
      clearSelection();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to update working set"); } finally { setBusy(false); }
  }

  async function setAll(included: boolean) {
    if (!project || !revision) return;
    setBusy(true); setMessage("");
    try {
      setPrep(await setAllImageInclusion(project.id, revision.id, included));
      await refreshAll(); clearSelection();
      setMessage(included ? "All incoming images included." : "All incoming images excluded.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to update working set"); } finally { setBusy(false); }
  }

  async function saveGlobalTransform() {
    if (!project || !revision) return;
    setBusy(true); setMessage("");
    try {
      const state = await setGlobalImageTransform(project.id, revision.id, globalDraft);
      setPrep(state); setGlobalDraft(state.global_transform);
      setMessage("Global transform recipe saved. Per-image overrides remain independent.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save transform recipe"); } finally { setBusy(false); }
  }

  function openEditor(filename: string) {
    if (editName === filename) { setEditName(""); return; }
    const asset = transformed.find((item) => item.filename === filename);
    setEditName(filename);
    setOverrideDraft(asset?.transform_override || {});
  }

  async function saveOverride() {
    if (!project || !revision || !editAsset) return;
    setBusy(true); setMessage("");
    try {
      const state = await setAssetImageTransform(project.id, revision.id, editAsset.filename, overrideDraft);
      setPrep(state); await refreshAll();
      setMessage(`Override saved for ${editAsset.filename}.`);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save image override"); } finally { setBusy(false); }
  }

  async function resetOverride() {
    if (!project || !revision || !editAsset) return;
    setBusy(true);
    try {
      const state = await setAssetImageTransform(project.id, revision.id, editAsset.filename, {});
      setPrep(state); setOverrideDraft({}); await refreshAll();
      setMessage(`${editAsset.filename} now uses only the global recipe.`);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to reset override"); } finally { setBusy(false); }
  }

  function manualCropRect() {
    const target = aspectNumber(manualAspect);
    const source = manualDims.width / Math.max(1, manualDims.height);
    let width: number; let height: number;
    if (source >= target) { height = manualScale; width = manualScale * target / source; }
    else { width = manualScale; height = manualScale * source / target; }
    const x = Math.min(1 - width, Math.max(0, manualCenterX - width / 2));
    const y = Math.min(1 - height, Math.max(0, manualCenterY - height / 2));
    return { x, y, width, height };
  }

  async function addManualDerivative() {
    if (!project || !revision || !manualAsset) return;
    setBusy(true); setMessage("");
    try {
      const result = await createManualCrop(project.id, revision.id, manualAsset.filename, manualAspect, manualCropRect());
      setPrep(result.state); await refreshAll();
      setMessage(`${result.asset.filename} created as a new derivative and marked as needing a caption.`);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to create manual derivative"); } finally { setBusy(false); }
  }

  if (!project || !revision || !dataset) {
    return <section className="panel hero-panel stack"><p className="eyebrow">Project required</p><h1>Image Prep</h1><p className="muted">Open a project and choose a model-specific working dataset first.</p></section>;
  }

  const included = prep?.included_count ?? includedAssets.length;
  const excluded = prep?.excluded_count ?? assets.length - included;
  const derivatives = prep?.derivative_count ?? assets.filter((asset) => asset.asset_kind === "derived").length;
  const manualRect = manualCropRect();
  const targetAspect = globalDraft.aspect_ratio || "16:9";

  return <div className="stack image-prep-page">
    <header className="page-header">
      <div><p className="eyebrow">{project.name} · {revision.name}</p><h1>Build the Training Dataset</h1><p className="muted">Select the batch, create derivatives, then apply one global model-aware recipe with per-image exceptions.</p></div>
      <div className="prep-counts"><span><strong>{assets.length}</strong> assets</span><span className="status-good"><strong>{included}</strong> working</span><span><strong>{derivatives}</strong> derived</span><span className="status-suspect"><strong>{excluded}</strong> excluded</span></div>
    </header>

    <section className="prep-flow"><div className="flow-step active"><b>1</b><span><strong>Select Intake</strong><small>Choose source images</small></span></div><div className="flow-arrow">→</div><div className="flow-step active"><b>2</b><span><strong>Create Derivatives</strong><small>Auto or manual crops</small></span></div><div className="flow-arrow">→</div><div className="flow-step active"><b>3</b><span><strong>Transform</strong><small>Global + exceptions</small></span></div><div className="flow-arrow">→</div><div className="flow-step"><b>4</b><span><strong>Captions</strong><small>Condition final assets</small></span></div></section>

    {message && <div className={message.toLowerCase().includes("unable") ? "notice error" : "notice success"}>{message}</div>}

    <section className="panel stack">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 1</p><div className="card-title">Incoming Batch</div><p className="muted">Choose which imported images participate in this project dataset. Exclusion is reversible and never changes the external source.</p></div><div className="actions"><button className="secondary" onClick={() => setAll(true)} disabled={busy}>Include all</button><button className="secondary" onClick={() => setAll(false)} disabled={busy}>Exclude all</button></div></div>
      <div className="prep-toolbar"><div className="segmented"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All {assets.length}</button><button className={filter === "included" ? "selected" : ""} onClick={() => setFilter("included")}>Working {included}</button><button className={filter === "excluded" ? "selected" : ""} onClick={() => setFilter("excluded")}>Excluded {excluded}</button></div><div className="actions"><button className="secondary" onClick={selectVisible}>Select visible</button><button className="secondary" onClick={clearSelection} disabled={!selected.size}>Clear</button></div></div>
      <div className="prep-grid">{visible.map((asset) => { const image = dataset.images.find((item) => item.filename === asset.filename); if (!image) return null; const isIncluded = asset.included !== false; const isSelected = selected.has(asset.filename); return <button key={asset.filename} className={`prep-image-card ${isSelected ? "selected" : ""} ${!isIncluded ? "excluded" : ""}`} onClick={() => toggle(asset.filename)}><div className="prep-image-wrap"><img src={image.image_url} alt={asset.filename} /><span className="select-check">{isSelected ? "✓" : ""}</span>{asset.asset_kind === "derived" && <span className="derived-badge">Derived</span>}</div><div className="prep-image-meta"><strong>{asset.filename}</strong><span className={isIncluded ? "status-good" : "status-suspect"}>{isIncluded ? "In working set" : "Excluded"}</span></div></button>; })}</div>
      <div className="selection-bar"><span><strong>{selected.size}</strong> selected</span><div className="actions"><button className="secondary" disabled={!selected.size || busy} onClick={() => setIncluded(false)}>Exclude selected</button><button className="primary" disabled={!selected.size || busy} onClick={() => setIncluded(true)}>Include selected</button></div></div>
    </section>

    <section className="panel stack">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 2</p><div className="card-title">Create Derivatives</div><p className="muted">Automatic face/body detection and deliberate manual crops both create new assets with parent lineage. The parent stays untouched.</p></div><span className="badge">{derivatives} created</span></div>
      <div className="derivative-tabs"><button className="secondary" disabled>Detect face / body · next</button><span className="muted">Manual crop is active now.</span></div>
      <div className="manual-crop-layout">
        <div className="stack">
          <label>Parent image<select value={manualAsset?.filename || ""} onChange={(event) => setManualParent(event.target.value)}>{sourceAssets.map((asset) => <option key={asset.filename} value={asset.filename}>{asset.filename}</option>)}</select></label>
          <div className="manual-crop-preview">{manualImage && <><img src={manualImage.image_url} alt={manualAsset?.filename} onLoad={(event) => setManualDims({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} /><div className="crop-mask"><div className="crop-box" style={{ left: `${manualRect.x * 100}%`, top: `${manualRect.y * 100}%`, width: `${manualRect.width * 100}%`, height: `${manualRect.height * 100}%` }} /></div></>}</div>
        </div>
        <div className="stack manual-crop-controls">
          <label>Derivative aspect<select value={manualAspect} onChange={(event) => setManualAspect(event.target.value)}>{ASPECTS.map((aspect) => <option key={aspect}>{aspect}</option>)}</select></label>
          <label>Crop size <span>{Math.round(manualScale * 100)}%</span><input type="range" min="0.2" max="1" step="0.01" value={manualScale} onChange={(event) => setManualScale(Number(event.target.value))} /></label>
          <label>Horizontal position <span>{Math.round(manualCenterX * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={manualCenterX} onChange={(event) => setManualCenterX(Number(event.target.value))} /></label>
          <label>Vertical position <span>{Math.round(manualCenterY * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={manualCenterY} onChange={(event) => setManualCenterY(Number(event.target.value))} /></label>
          <div className="notice">The new image starts with an empty canonical caption, so it will automatically appear as needing work on the Captions page.</div>
          <button className="primary" disabled={!manualAsset || busy} onClick={addManualDerivative}>Create {manualAspect} derivative</button>
        </div>
      </div>
    </section>

    <section className="panel stack transform-workbench">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 3</p><div className="card-title">Global Transform</div><p className="muted">Set the normal treatment for the whole working set. This is the baseline; individual images can override only what needs attention.</p></div><span className="badge">{modelFamily === "krea2" ? "Krea 2" : "Klein"}</span></div>
      <div className="global-transform-grid">
        <label>Aspect<select value={targetAspect} onChange={(event) => setGlobalDraft({ ...globalDraft, aspect_ratio: event.target.value })}>{ASPECTS.map((aspect) => <option key={aspect}>{aspect}</option>)}</select></label>
        <label>Width<input type="number" value={globalDraft.target_width ?? 1344} onChange={(event) => setGlobalDraft({ ...globalDraft, target_width: Number(event.target.value) })} /></label>
        <label>Height<input type="number" value={globalDraft.target_height ?? 768} onChange={(event) => setGlobalDraft({ ...globalDraft, target_height: Number(event.target.value) })} /></label>
        <label>Crop mode<select value={globalDraft.crop_mode ?? "fill"} onChange={(event) => setGlobalDraft({ ...globalDraft, crop_mode: event.target.value as "fill" | "fit" })}><option value="fill">Fill / crop</option><option value="fit">Fit</option></select></label>
        <label>Exposure<input type="number" step="0.1" value={globalDraft.exposure ?? 0} onChange={(event) => setGlobalDraft({ ...globalDraft, exposure: Number(event.target.value) })} /></label>
        <label>Brightness<input type="number" step="0.05" value={globalDraft.brightness ?? 0} onChange={(event) => setGlobalDraft({ ...globalDraft, brightness: Number(event.target.value) })} /></label>
        <label>Contrast<input type="number" step="0.05" value={globalDraft.contrast ?? 0} onChange={(event) => setGlobalDraft({ ...globalDraft, contrast: Number(event.target.value) })} /></label>
        <label>Gamma<input type="number" min="0.1" step="0.05" value={globalDraft.gamma ?? 1} onChange={(event) => setGlobalDraft({ ...globalDraft, gamma: Number(event.target.value) })} /></label>
      </div>
      <div className="actions"><button className="primary" onClick={saveGlobalTransform} disabled={busy}>Save global recipe</button></div>

      <div className="prep-section-heading processed-heading"><div><div className="card-title">Processed Working Set</div><p className="muted">Click an image to open its inline exception editor. The editor interrupts the grid so the remaining images slide down rather than taking you away from the batch.</p></div></div>
      <div className="processed-grid">
        {transformed.map((asset) => {
          const image = dataset.images.find((item) => item.filename === asset.filename);
          if (!image) return null;
          const active = editName === asset.filename;
          const overrideCount = Object.keys(asset.transform_override || {}).length;
          return <div key={asset.filename} className="processed-grid-item">
            <button className={`processed-card ${active ? "selected" : ""}`} onClick={() => openEditor(asset.filename)}><div className="processed-image" style={{ aspectRatio: aspectNumber(targetAspect), ['--crop-x' as string]: `${((asset.transform_override?.crop_x ?? globalDraft.crop_x ?? 0.5) * 100)}%`, ['--crop-y' as string]: `${((asset.transform_override?.crop_y ?? globalDraft.crop_y ?? 0.5) * 100)}%` }}><img src={image.image_url} alt={asset.filename} /></div><div className="prep-image-meta"><strong>{asset.filename}</strong><span>{overrideCount ? `${overrideCount} override${overrideCount === 1 ? "" : "s"}` : "Global recipe"}</span></div></button>
            {active && <div className="inline-image-editor">
              <div className="inline-editor-preview"><img src={image.image_url} alt={asset.filename} style={{ objectPosition: `${((overrideDraft.crop_x ?? globalDraft.crop_x ?? 0.5) * 100)}% ${((overrideDraft.crop_y ?? globalDraft.crop_y ?? 0.5) * 100)}%` }} /></div>
              <div className="stack inline-editor-controls"><div><p className="eyebrow">Per-image exception</p><div className="card-title">{asset.filename}</div><p className="muted">Values left unset inherit the global recipe.</p></div>
                <label>Crop horizontal <span>{Math.round((overrideDraft.crop_x ?? globalDraft.crop_x ?? 0.5) * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={overrideDraft.crop_x ?? globalDraft.crop_x ?? 0.5} onChange={(event) => setOverrideDraft({ ...overrideDraft, crop_x: Number(event.target.value) })} /></label>
                <label>Crop vertical <span>{Math.round((overrideDraft.crop_y ?? globalDraft.crop_y ?? 0.5) * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={overrideDraft.crop_y ?? globalDraft.crop_y ?? 0.5} onChange={(event) => setOverrideDraft({ ...overrideDraft, crop_y: Number(event.target.value) })} /></label>
                <div className="form-row"><label>Exposure<input type="number" step="0.1" placeholder={String(globalDraft.exposure ?? 0)} value={overrideDraft.exposure ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, exposure: event.target.value === "" ? undefined : Number(event.target.value) })} /></label><label>Brightness<input type="number" step="0.05" placeholder={String(globalDraft.brightness ?? 0)} value={overrideDraft.brightness ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, brightness: event.target.value === "" ? undefined : Number(event.target.value) })} /></label></div>
                <div className="form-row"><label>Contrast<input type="number" step="0.05" placeholder={String(globalDraft.contrast ?? 0)} value={overrideDraft.contrast ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, contrast: event.target.value === "" ? undefined : Number(event.target.value) })} /></label><label>Gamma<input type="number" min="0.1" step="0.05" placeholder={String(globalDraft.gamma ?? 1)} value={overrideDraft.gamma ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, gamma: event.target.value === "" ? undefined : Number(event.target.value) })} /></label></div>
                <div className="actions"><button className="secondary" onClick={resetOverride} disabled={busy}>Reset to global</button><button className="primary" onClick={saveOverride} disabled={busy}>Save image override</button></div>
              </div>
            </div>}
          </div>;
        })}
      </div>
      <div className="notice">The UI now records the transform recipe and exceptions. Actual final crop/resize/tonal materialization will be added as the transform execution pass, using these exact saved values.</div>
      <div className="actions"><button className="primary" disabled={!included} onClick={() => navigate("/captions")}>Continue to Captions →</button></div>
    </section>
  </div>;
}
