import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getImagePrepState, getProjectRevision, setAllImageInclusion, setImageInclusion, type ImagePrepState } from "../api";
import { useSession } from "../session";

type Filter = "all" | "included" | "excluded";

export function ImagePrepPage() {
  const navigate = useNavigate();
  const { project, revision, setRevision, dataset, modelFamily } = useSession();
  const [prep, setPrep] = useState<ImagePrepState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!project || !revision) return;
    getImagePrepState(project.id, revision.id).then(setPrep).catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load image prep state"));
  }, [project, revision]);

  const assets = prep?.assets ?? revision?.assets ?? [];
  const visible = useMemo(() => assets.filter((asset) => {
    const included = asset.included !== false;
    return filter === "all" || (filter === "included" ? included : !included);
  }), [assets, filter]);

  function toggle(filename: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(filename)) next.delete(filename); else next.add(filename);
      return next;
    });
  }

  function selectVisible() { setSelected(new Set(visible.map((asset) => asset.filename))); }
  function clearSelection() { setSelected(new Set()); }

  async function refreshRevision() {
    if (!project || !revision) return;
    setRevision(await getProjectRevision(project.id, revision.id));
  }

  async function setIncluded(included: boolean) {
    if (!project || !revision || !selected.size) return;
    setBusy(true); setMessage("");
    try {
      setPrep(await setImageInclusion(project.id, revision.id, [...selected], included));
      await refreshRevision();
      setMessage(`${selected.size} image${selected.size === 1 ? "" : "s"} ${included ? "included in" : "excluded from"} the working set.`);
      clearSelection();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to update working set"); } finally { setBusy(false); }
  }

  async function setAll(included: boolean) {
    if (!project || !revision) return;
    setBusy(true); setMessage("");
    try {
      setPrep(await setAllImageInclusion(project.id, revision.id, included));
      await refreshRevision(); clearSelection();
      setMessage(included ? "All incoming images included." : "All incoming images excluded.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to update working set"); } finally { setBusy(false); }
  }

  if (!project || !revision || !dataset) {
    return <section className="panel hero-panel stack"><p className="eyebrow">Project required</p><h1>Image Prep</h1><p className="muted">Open a project and choose a model-specific working dataset first.</p></section>;
  }

  const included = prep?.included_count ?? assets.filter((asset) => asset.included !== false).length;
  const excluded = prep?.excluded_count ?? assets.length - included;
  const derivatives = prep?.derivative_count ?? assets.filter((asset) => asset.asset_kind === "derived").length;

  return <div className="stack image-prep-page">
    <header className="page-header">
      <div><p className="eyebrow">{project.name} · {revision.name}</p><h1>Build the Training Dataset</h1><p className="muted">Choose what enters this experiment, create useful derivatives, then normalize the final working set for {modelFamily === "krea2" ? "Krea 2" : "Klein"}. Nothing here changes the external source.</p></div>
      <div className="prep-counts"><span><strong>{assets.length}</strong> incoming</span><span className="status-good"><strong>{included}</strong> working</span><span><strong>{derivatives}</strong> derived</span><span className="status-suspect"><strong>{excluded}</strong> excluded</span></div>
    </header>

    <section className="prep-flow" aria-label="Image preparation flow">
      <div className="flow-step active"><b>1</b><span><strong>Select Intake</strong><small>Choose source images</small></span></div>
      <div className="flow-arrow">→</div>
      <div className="flow-step"><b>2</b><span><strong>Create Derivatives</strong><small>Face / detail crops</small></span></div>
      <div className="flow-arrow">→</div>
      <div className="flow-step"><b>3</b><span><strong>Working Set</strong><small>Review effective dataset</small></span></div>
      <div className="flow-arrow">→</div>
      <div className="flow-step"><b>4</b><span><strong>Transform</strong><small>Model-native geometry</small></span></div>
    </section>

    {message && <div className={message.toLowerCase().includes("unable") ? "notice error" : "notice success"}>{message}</div>}

    <section className="panel stack">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 1</p><div className="card-title">Incoming Batch</div><p className="muted">Selection here controls membership in this project dataset only. Excluded images remain in the immutable import snapshot and can be brought back later.</p></div><div className="actions"><button className="secondary" onClick={() => setAll(true)} disabled={busy}>Include all</button><button className="secondary" onClick={() => setAll(false)} disabled={busy}>Exclude all</button></div></div>
      <div className="prep-toolbar"><div className="segmented"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All {assets.length}</button><button className={filter === "included" ? "selected" : ""} onClick={() => setFilter("included")}>Working {included}</button><button className={filter === "excluded" ? "selected" : ""} onClick={() => setFilter("excluded")}>Excluded {excluded}</button></div><div className="actions"><button className="secondary" onClick={selectVisible}>Select visible</button><button className="secondary" onClick={clearSelection} disabled={!selected.size}>Clear</button></div></div>

      <div className="prep-grid">
        {visible.map((asset) => {
          const image = dataset.images.find((item) => item.filename === asset.filename);
          if (!image) return null;
          const isIncluded = asset.included !== false;
          const isSelected = selected.has(asset.filename);
          return <button key={asset.filename} className={`prep-image-card ${isSelected ? "selected" : ""} ${!isIncluded ? "excluded" : ""}`} onClick={() => toggle(asset.filename)}>
            <div className="prep-image-wrap"><img src={image.image_url} alt={asset.filename} /><span className="select-check">{isSelected ? "✓" : ""}</span>{asset.asset_kind === "derived" && <span className="derived-badge">Derived</span>}</div>
            <div className="prep-image-meta"><strong>{asset.filename}</strong><span className={isIncluded ? "status-good" : "status-suspect"}>{isIncluded ? "In working set" : "Excluded"}</span></div>
          </button>;
        })}
      </div>

      <div className="selection-bar">
        <span><strong>{selected.size}</strong> selected</span>
        <div className="actions"><button className="secondary" disabled={!selected.size || busy} onClick={() => setIncluded(false)}>Exclude selected</button><button className="primary" disabled={!selected.size || busy} onClick={() => setIncluded(true)}>Include selected</button></div>
      </div>
    </section>

    <div className="grid-2 prep-next-grid">
      <section className="panel stack">
        <div><p className="eyebrow">Stage 2</p><div className="card-title">Create Derivatives</div></div>
        <p className="muted">Run face detection against the included batch, preview proposed crops, and add only the useful ones. A derivative becomes a new project asset with lineage back to its parent image and starts with no caption unless we deliberately inherit one.</p>
        <div className="derivative-preview"><div className="face-frame">Face crop</div><div className="face-frame secondary-frame">Upper body</div></div>
        <button className="secondary" disabled>Detect faces · backend next</button>
      </section>

      <section className="panel stack">
        <div><p className="eyebrow">Stage 3</p><div className="card-title">Effective Working Set</div></div>
        <div className="summary-grid"><div><span>Original assets</span><strong>{included - derivatives}</strong></div><div><span>Derived assets</span><strong>{derivatives}</strong></div><div><span>Total</span><strong>{included}</strong></div></div>
        <p className="muted">This is the set that will flow into model-specific transforms and then Captions. Newly-created derivatives will automatically surface as needing captions.</p>
      </section>
    </div>

    <section className="panel stack">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 4</p><div className="card-title">Transformation Pipeline</div><p className="muted">Operations are non-destructive and can be applied globally, to a selected batch, or overridden per image.</p></div><span className="badge">{modelFamily === "krea2" ? "Krea 2 targets" : "Klein targets"}</span></div>
      <div className="pipeline-row"><div className="pipeline-node"><span>Aspect / Crop</span><strong>Model preset</strong><small>Fit, fill, reposition</small></div><span>→</span><div className="pipeline-node"><span>Resize</span><strong>Native bucket</strong><small>Per aspect ratio</small></div><span>→</span><div className="pipeline-node"><span>Adjust</span><strong>Optional</strong><small>Exposure / contrast</small></div><span>→</span><div className="pipeline-node"><span>Output</span><strong>Working image</strong><small>Tracked provenance</small></div></div>
      <div className="notice">The transformation execution layer is intentionally next: target geometries need to be model-aware, and each materialized result will record its exact crop rectangle, dimensions and adjustments in project history.</div>
      <div className="actions"><button className="primary" disabled={!included} onClick={() => navigate("/captions")}>Continue to Captions →</button></div>
    </section>
  </div>;
}
