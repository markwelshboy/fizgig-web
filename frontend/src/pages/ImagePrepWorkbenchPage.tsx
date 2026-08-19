import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  acceptFaceCrops,
  createManualCrop,
  getImagePrepState,
  getProjectRevision,
  inspectDataset,
  proposeFaceCrops,
  setAllImageInclusion,
  setAssetImageTransform,
  setGlobalImageTransform,
  setImageInclusion,
  setTrainingResolution,
  type FaceCropProposal,
  type ImagePrepState,
  type ImageTransform,
  type ProjectAsset,
  type ResolutionAsset,
  type TrainingResolutionPolicy,
} from "../api";
import { useSession } from "../session";

type Filter = "all" | "included" | "excluded";
type CropRect = { x: number; y: number; width: number; height: number };
type DragMode = "move" | "nw" | "ne" | "sw" | "se" | null;

const ASPECTS = ["source", "16:9", "1:1", "4:5", "5:4", "9:16"];
const DERIVATIVE_ASPECTS = ["1:1", "4:5", "5:4", "9:16", "16:9"];
const MP_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.5];

function aspectNumber(value: string, fallback = 1) {
  if (value === "source") return fallback;
  const [w, h] = value.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : fallback;
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function cropLoss(row: ResolutionAsset) {
  const source = Math.max(1, row.file_width * row.file_height);
  const effective = Math.max(1, row.crop_width * row.crop_height);
  return Math.max(0, 1 - effective / source);
}

function cropFromCenter(aspect: string, imageWidth: number, imageHeight: number, scale = 0.8): CropRect {
  const sourceAspect = imageWidth / Math.max(1, imageHeight);
  const target = aspectNumber(aspect, sourceAspect);
  let width: number;
  let height: number;
  if (sourceAspect >= target) {
    height = scale;
    width = scale * target / sourceAspect;
  } else {
    width = scale;
    height = scale * sourceAspect / target;
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

function clampCrop(rect: CropRect, aspect: string, imageWidth: number, imageHeight: number): CropRect {
  const sourceAspect = imageWidth / Math.max(1, imageHeight);
  const target = aspectNumber(aspect, sourceAspect);
  let width = Math.max(0.05, Math.min(1, rect.width));
  let height = width * sourceAspect / target;
  if (height > 1) {
    height = 1;
    width = height * target / sourceAspect;
  }
  if (height < 0.05) {
    height = 0.05;
    width = height * target / sourceAspect;
  }
  return {
    x: Math.max(0, Math.min(1 - width, rect.x)),
    y: Math.max(0, Math.min(1 - height, rect.y)),
    width,
    height,
  };
}

function ManualCropEditor({ imageUrl, filename, aspect, onCreate, busy }: { imageUrl: string; filename: string; aspect: string; onCreate: (crop: CropRect) => void; busy: boolean }) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ width: 1, height: 1 });
  const [crop, setCrop] = useState<CropRect>(() => cropFromCenter(aspect, 1, 1));
  const [drag, setDrag] = useState<{ mode: DragMode; startX: number; startY: number; start: CropRect } | null>(null);

  useEffect(() => { setCrop(cropFromCenter(aspect, dims.width, dims.height)); }, [aspect, dims.width, dims.height, filename]);

  function pointerFraction(event: React.PointerEvent) {
    const bounds = canvasRef.current!.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  }

  function startDrag(event: React.PointerEvent, mode: DragMode) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = pointerFraction(event);
    setDrag({ mode, startX: p.x, startY: p.y, start: crop });
  }

  function moveDrag(event: React.PointerEvent) {
    if (!drag) return;
    const p = pointerFraction(event);
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    if (drag.mode === "move") {
      setCrop(clampCrop({ ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy }, aspect, dims.width, dims.height));
      return;
    }
    const right = drag.start.x + drag.start.width;
    const bottom = drag.start.y + drag.start.height;
    let width = drag.start.width;
    let x = drag.start.x;
    if (drag.mode === "nw" || drag.mode === "sw") {
      width = Math.max(0.05, drag.start.width - dx);
      x = right - width;
    } else {
      width = Math.max(0.05, drag.start.width + dx);
    }
    let next = clampCrop({ x, y: drag.start.y, width, height: drag.start.height }, aspect, dims.width, dims.height);
    if (drag.mode === "nw" || drag.mode === "ne") next = { ...next, y: bottom - next.height };
    setCrop(clampCrop(next, aspect, dims.width, dims.height));
  }

  const pxW = Math.max(1, Math.round(crop.width * dims.width));
  const pxH = Math.max(1, Math.round(crop.height * dims.height));

  return <div className="manual-editor-shell">
    <div ref={canvasRef} className="manual-crop-canvas" style={{ aspectRatio: `${dims.width} / ${dims.height}` }} onPointerMove={moveDrag} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
      <img src={imageUrl} alt={filename} draggable={false} onLoad={(event) => setDims({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
      <div className="manual-source-size">Source {dims.width}×{dims.height}</div>
      <div className="interactive-crop-box" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={(event) => startDrag(event, "move")}>
        <span className="crop-size-label">{pxW} × {pxH}</span>
        {(["nw", "ne", "sw", "se"] as const).map((corner) => <span key={corner} className={`crop-handle ${corner}`} onPointerDown={(event) => startDrag(event, corner)} />)}
      </div>
    </div>
    <div className="manual-crop-summary"><span>{aspect} crop</span><strong>{pxW} × {pxH}</strong><span>{(pxW * pxH / 1_000_000).toFixed(2)} MP source detail</span></div>
    <button className="primary" disabled={busy} onClick={() => onCreate(crop)}>Create {aspect} derivative</button>
  </div>;
}

function BucketPreview({ rows, assets, onReviewCrop }: { rows: ResolutionAsset[]; assets: ProjectAsset[]; onReviewCrop: (filename: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; width: number; height: number; count: number; filenames: string[] }>();
    for (const row of rows) {
      const key = `${row.bucket_width}×${row.bucket_height}`;
      const group = map.get(key) ?? { key, width: row.bucket_width, height: row.bucket_height, count: 0, filenames: [] };
      group.count += 1;
      group.filenames.push(row.filename);
      map.set(key, group);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }, [rows]);

  const significant = rows.filter((row) => cropLoss(row) > 0.05);
  const sourceCount = rows.filter((row) => assets.find((asset) => asset.filename === row.filename)?.asset_kind !== "derived").length;

  return <div className="bucket-preview stack">
    <div className="prep-section-heading">
      <div><div className="card-title">Expected bucket groups</div><p className="muted">Fizgig Web preview based on the current working images and pixel budget. Exact trainer-assigned dimensions are confirmed after dataset caching.</p></div>
      <div className="bucket-summary"><strong>{groups.length}</strong><span>expected groups</span><strong>{rows.length}</strong><span>images</span></div>
    </div>
    <div className="bucket-group-grid">
      {groups.map((group) => <details className="bucket-group" key={group.key}><summary><strong>{group.key}</strong><span>{group.count} image{group.count === 1 ? "" : "s"}</span></summary><div className="bucket-file-list">{group.filenames.map((filename) => <span key={filename}>{filename}</span>)}</div></details>)}
    </div>
    <div className={significant.length ? "notice" : "notice success"}>
      <strong>{significant.length}</strong> image{significant.length === 1 ? "" : "s"} require more than 5% composition crop before bucketing. {sourceCount} source images are represented in this preview.
      {significant.length > 0 && <div className="crop-review-actions">{significant.slice(0, 6).map((row) => <button className="secondary" key={row.filename} onClick={() => onReviewCrop(row.filename)}>Review {row.filename} · {(cropLoss(row) * 100).toFixed(0)}%</button>)}</div>}
    </div>
  </div>;
}

export function ImagePrepWorkbenchPage() {
  const navigate = useNavigate();
  const { project, revision, setRevision, dataset, setDataset, modelFamily } = useSession();
  const [prep, setPrep] = useState<ImagePrepState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [focusName, setFocusName] = useState("");
  const [editName, setEditName] = useState("");
  const [globalDraft, setGlobalDraft] = useState<ImageTransform>({});
  const [resolutionDraft, setResolutionDraft] = useState<TrainingResolutionPolicy>({ max_megapixels: 1, enable_bucket: true, bucket_no_upscale: true, dimension_step: 16 });
  const [overrideDraft, setOverrideDraft] = useState<ImageTransform>({});
  const [manualAspect, setManualAspect] = useState("1:1");
  const [faceAspect, setFaceAspect] = useState("1:1");
  const [facePadding, setFacePadding] = useState(60);
  const [faceProposals, setFaceProposals] = useState<FaceCropProposal[]>([]);
  const [acceptedProposalIds, setAcceptedProposalIds] = useState<Set<string>>(new Set());

  async function loadPrep() {
    if (!project || !revision) return;
    let state = await getImagePrepState(project.id, revision.id);
    const g = state.global_transform || {};
    if (g.aspect_ratio === "16:9" && (g.crop_x ?? 0.5) === 0.5 && (g.crop_y ?? 0.5) === 0.5 && (g.exposure ?? 0) === 0 && (g.brightness ?? 0) === 0 && (g.contrast ?? 0) === 0 && (g.gamma ?? 1) === 1) {
      state = await setGlobalImageTransform(project.id, revision.id, { ...g, aspect_ratio: "source", crop_mode: "fit" });
    }
    setPrep(state);
    setGlobalDraft(state.global_transform || { aspect_ratio: "source", crop_mode: "fit" });
    setResolutionDraft(state.training_resolution);
    const first = state.assets.find((asset) => asset.included !== false)?.filename || state.assets[0]?.filename || "";
    setFocusName((current) => current || first);
  }

  useEffect(() => { loadPrep().catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load image prep state")); }, [project, revision?.id]);

  const assets = prep?.assets ?? revision?.assets ?? [];
  const includedAssets = assets.filter((asset) => asset.included !== false);
  const sourceAssets = includedAssets.filter((asset) => asset.asset_kind !== "derived");
  const visible = useMemo(() => assets.filter((asset) => filter === "all" || (filter === "included" ? asset.included !== false : asset.included === false)), [assets, filter]);
  const focusAsset = includedAssets.find((asset) => asset.filename === focusName) ?? includedAssets[0];
  const focusImage = dataset?.images.find((image) => image.filename === focusAsset?.filename);
  const focusIndex = focusAsset ? includedAssets.findIndex((asset) => asset.filename === focusAsset.filename) : -1;
  const editAsset = includedAssets.find((asset) => asset.filename === editName);
  const targetAspect = globalDraft.aspect_ratio || "source";
  const resolutionRows = prep?.resolution_assets ?? [];
  const globalDirty = !sameJson(globalDraft, prep?.global_transform);
  const resolutionDirty = !sameJson(resolutionDraft, prep?.training_resolution);
  const overrideDirty = !sameJson(overrideDraft, editAsset?.transform_override ?? {});

  useEffect(() => { if (focusAsset && focusName !== focusAsset.filename) setFocusName(focusAsset.filename); }, [focusAsset?.filename]);

  async function refreshAll() {
    if (!project || !revision) return;
    const nextRevision = await getProjectRevision(project.id, revision.id);
    setRevision(nextRevision);
    const state = await getImagePrepState(project.id, revision.id);
    setPrep(state);
    setGlobalDraft(state.global_transform || {});
    setResolutionDraft(state.training_resolution);
    setDataset(await inspectDataset(nextRevision.files_path));
  }

  function toggleSelected(filename: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(filename)) next.delete(filename); else next.add(filename);
      return next;
    });
  }

  async function setIncluded(included: boolean) {
    if (!project || !revision || !selected.size) return;
    setBusy(true);
    try {
      await setImageInclusion(project.id, revision.id, [...selected], included);
      setMessage(`${selected.size} image(s) ${included ? "included" : "excluded"}.`);
      setSelected(new Set());
      await refreshAll();
    } finally { setBusy(false); }
  }

  async function setAll(included: boolean) {
    if (!project || !revision) return;
    setBusy(true);
    try {
      await setAllImageInclusion(project.id, revision.id, included);
      setSelected(new Set());
      await refreshAll();
    } finally { setBusy(false); }
  }

  function stepFocus(delta: number) {
    if (!includedAssets.length) return;
    const index = focusIndex < 0 ? 0 : (focusIndex + delta + includedAssets.length) % includedAssets.length;
    setFocusName(includedAssets[index].filename);
  }

  async function saveGlobalTransform() {
    if (!project || !revision || !globalDirty) return;
    setBusy(true);
    try {
      const state = await setGlobalImageTransform(project.id, revision.id, globalDraft);
      setPrep(state);
      setGlobalDraft(state.global_transform);
      setMessage("Base composition and adjustment recipe saved.");
    } finally { setBusy(false); }
  }

  async function saveResolution() {
    if (!project || !revision || !resolutionDirty) return;
    setBusy(true);
    try {
      const state = await setTrainingResolution(project.id, revision.id, resolutionDraft);
      setPrep(state);
      setResolutionDraft(state.training_resolution);
      setMessage(`Maximum training resolution set to ${state.training_resolution.max_megapixels} MP.`);
    } finally { setBusy(false); }
  }

  async function addManualDerivative(crop: CropRect) {
    if (!project || !revision || !focusAsset) return;
    setBusy(true);
    try {
      const result = await createManualCrop(project.id, revision.id, focusAsset.filename, manualAspect, crop);
      await refreshAll();
      setFocusName(result.asset.filename);
      setMessage(`${result.asset.filename} created from ${focusAsset.filename}; it now needs a caption.`);
    } finally { setBusy(false); }
  }

  async function detectFaces() {
    if (!project || !revision) return;
    setBusy(true);
    try {
      const names = selected.size ? [...selected].filter((name) => sourceAssets.some((asset) => asset.filename === name)) : sourceAssets.map((asset) => asset.filename);
      const result = await proposeFaceCrops(project.id, revision.id, names, faceAspect, facePadding);
      setFaceProposals(result.proposals);
      setAcceptedProposalIds(new Set(result.proposals.map((proposal) => proposal.id)));
      setMessage(`Detected ${result.proposals.length} face crop proposal(s) across ${names.length} source image(s).`);
    } catch (err) {
      setMessage(err instanceof Error ? `Face detection: ${err.message}` : "Face detection failed");
    } finally { setBusy(false); }
  }

  async function createFaceDerivatives() {
    if (!project || !revision) return;
    const chosen = faceProposals.filter((proposal) => acceptedProposalIds.has(proposal.id));
    if (!chosen.length) return;
    setBusy(true);
    try {
      const result = await acceptFaceCrops(project.id, revision.id, chosen);
      setFaceProposals([]);
      setAcceptedProposalIds(new Set());
      await refreshAll();
      setMessage(`${result.assets.length} face derivative(s) added; each now needs a caption.`);
    } finally { setBusy(false); }
  }

  function openEditor(filename: string) {
    const asset = includedAssets.find((item) => item.filename === filename);
    if (!asset) return;
    if (editName === filename) { setEditName(""); return; }
    setEditName(filename);
    setFocusName(filename);
    setOverrideDraft(asset.transform_override || {});
  }

  function reviewCrop(filename: string) {
    const asset = includedAssets.find((item) => item.filename === filename);
    if (!asset) return;
    setFocusName(filename);
    setEditName(filename);
    setOverrideDraft(asset.transform_override || {});
    requestAnimationFrame(() => document.getElementById("per-image-exceptions")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function saveOverride() {
    if (!project || !revision || !editAsset || !overrideDirty) return;
    setBusy(true);
    try {
      await setAssetImageTransform(project.id, revision.id, editAsset.filename, overrideDraft);
      await refreshAll();
      setMessage(`${editAsset.filename} override saved.`);
    } finally { setBusy(false); }
  }

  async function resetOverride() {
    if (!project || !revision || !editAsset) return;
    setBusy(true);
    try {
      await setAssetImageTransform(project.id, revision.id, editAsset.filename, {});
      setOverrideDraft({});
      await refreshAll();
    } finally { setBusy(false); }
  }

  if (!project || !revision || !dataset) return <section className="panel hero-panel stack"><p className="eyebrow">Project required</p><h1>Image Prep</h1><p className="muted">Open a project and choose a model-specific working dataset first.</p></section>;

  const included = prep?.included_count ?? includedAssets.length;
  const excluded = prep?.excluded_count ?? assets.length - included;
  const derivatives = prep?.derivative_count ?? 0;
  const downscaled = resolutionRows.filter((row) => row.direction === "downscale").length;
  const unchanged = resolutionRows.filter((row) => row.direction === "native").length;
  const lowDetail = resolutionRows.filter((row) => row.low_detail).length;

  return <div className="stack image-prep-page">
    <header className="page-header"><div><p className="eyebrow">{project.name} · {revision.name}</p><h1>Build the Training Dataset</h1><p className="muted">Choose the working set, control composition, add useful derivatives, then preview how those images group for training.</p></div><div className="prep-counts"><span><strong>{assets.length}</strong> assets</span><span className="status-good"><strong>{included}</strong> working</span><span><strong>{derivatives}</strong> derived</span><span className="status-suspect"><strong>{excluded}</strong> excluded</span></div></header>
    {message && <div className={message.startsWith("Face detection:") ? "notice error" : "notice success"}>{message}</div>}

    <section className="panel stack">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 1</p><div className="card-title">Incoming Batch</div><p className="muted">Click an image to make it active. Use the check box only for batch include/exclude. Hover to see the complete uncropped source.</p></div><div className="actions"><button className="secondary" onClick={() => setAll(true)}>Include all</button><button className="secondary" onClick={() => setAll(false)}>Exclude all</button></div></div>
      <div className="prep-toolbar"><div className="segmented"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All {assets.length}</button><button className={filter === "included" ? "selected" : ""} onClick={() => setFilter("included")}>Working {included}</button><button className={filter === "excluded" ? "selected" : ""} onClick={() => setFilter("excluded")}>Excluded {excluded}</button></div></div>
      <div className="prep-grid">{visible.map((asset) => { const image = dataset.images.find((item) => item.filename === asset.filename); if (!image) return null; return <div key={asset.filename} className={`prep-image-card ${focusName === asset.filename ? "focused" : ""} ${selected.has(asset.filename) ? "selected" : ""} ${asset.included === false ? "excluded" : ""}`}><button className="prep-focus-button" onClick={() => setFocusName(asset.filename)}><div className="prep-image-wrap hover-context"><img src={image.image_url} alt={asset.filename} />{asset.asset_kind === "derived" && <span className="derived-badge">Derived</span>}</div><div className="prep-image-meta"><strong>{asset.filename}</strong></div></button><button className={`batch-check ${selected.has(asset.filename) ? "checked" : ""}`} onClick={() => toggleSelected(asset.filename)} aria-label={`Select ${asset.filename} for batch action`}>{selected.has(asset.filename) ? "✓" : ""}</button></div>; })}</div>
      {selected.size > 0 && <div className="selection-bar"><span><strong>{selected.size}</strong> selected for batch action</span><div className="actions"><button className="secondary" disabled={busy} onClick={() => setIncluded(false)}>Exclude selected</button><button className="primary" disabled={busy} onClick={() => setIncluded(true)}>Include selected</button></div></div>}
    </section>

    <section className="panel stack">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 2</p><div className="card-title">Base Composition & Adjustments</div><p className="muted">Source / no crop preserves every image's original aspect. Choosing an aspect deliberately normalizes the base working images before trainer bucketing.</p></div>{focusAsset && <div className="image-stepper"><button onClick={() => stepFocus(-1)}>‹</button><span>{focusIndex + 1} / {includedAssets.length}</span><button onClick={() => stepFocus(1)}>›</button><strong>{focusAsset.filename}</strong></div>}</div>
      {focusImage && <div className="composition-preview-row"><div className="composition-preview"><img src={focusImage.image_url} alt={focusAsset?.filename} /></div><div className="global-transform-grid"><label>Base aspect<select value={targetAspect} onChange={(event) => { const value = event.target.value; setGlobalDraft({ ...globalDraft, aspect_ratio: value, crop_mode: value === "source" ? "fit" : "fill" }); }}>{ASPECTS.map((aspect) => <option key={aspect} value={aspect}>{aspect === "source" ? "Source / no crop" : aspect}</option>)}</select></label><label>Crop mode<select disabled={targetAspect === "source"} value={targetAspect === "source" ? "fit" : (globalDraft.crop_mode ?? "fill")} onChange={(event) => setGlobalDraft({ ...globalDraft, crop_mode: event.target.value as "fill" | "fit" })}><option value="fill">Fill / crop</option><option value="fit">Fit / no crop</option></select></label><label>Exposure<input type="number" step="0.1" value={globalDraft.exposure ?? 0} onChange={(event) => setGlobalDraft({ ...globalDraft, exposure: Number(event.target.value) })} /></label><label>Brightness<input type="number" step="0.05" value={globalDraft.brightness ?? 0} onChange={(event) => setGlobalDraft({ ...globalDraft, brightness: Number(event.target.value) })} /></label><label>Contrast<input type="number" step="0.05" value={globalDraft.contrast ?? 0} onChange={(event) => setGlobalDraft({ ...globalDraft, contrast: Number(event.target.value) })} /></label><label>Gamma<input type="number" step="0.05" value={globalDraft.gamma ?? 1} onChange={(event) => setGlobalDraft({ ...globalDraft, gamma: Number(event.target.value) })} /></label></div></div>}
      <button className="primary" disabled={busy || !globalDirty} onClick={saveGlobalTransform}>{globalDirty ? "Save base composition recipe" : "Base composition saved"}</button>
    </section>

    <section className="panel stack">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 3A</p><div className="card-title">Automatic Face Derivatives</div><p className="muted">InsightFace proposes crops from included source images. Nothing is added until you approve it.</p></div></div>
      <div className="form-row"><label>Derivative aspect<select value={faceAspect} onChange={(event) => setFaceAspect(event.target.value)}>{DERIVATIVE_ASPECTS.map((aspect) => <option key={aspect}>{aspect}</option>)}</select></label><label>Face padding %<input type="number" min="0" max="400" step="10" value={facePadding} onChange={(event) => setFacePadding(Number(event.target.value))} /></label><button className="secondary" disabled={busy || !sourceAssets.length} onClick={detectFaces}>{busy ? "Working…" : "Detect faces & propose crops"}</button></div>
      {faceProposals.length > 0 && <><div className="prep-grid">{faceProposals.map((proposal) => { const image = dataset.images.find((item) => item.filename === proposal.filename); if (!image) return null; const c = proposal.normalized_crop; return <button key={proposal.id} className={`prep-image-card ${acceptedProposalIds.has(proposal.id) ? "selected" : ""}`} onClick={() => setAcceptedProposalIds((current) => { const next = new Set(current); if (next.has(proposal.id)) next.delete(proposal.id); else next.add(proposal.id); return next; })}><div className="prep-image-wrap"><img src={image.image_url} alt={proposal.filename} /><div className="crop-mask"><div className="crop-box" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.width * 100}%`, height: `${c.height * 100}%` }} /></div></div><div className="prep-image-meta"><strong>{proposal.filename}</strong><span>Face {proposal.face_index + 1} · score {proposal.score}</span><span>{proposal.aspect_ratio} · {proposal.padding_percent}% padding</span></div></button>; })}</div><div className="selection-bar"><span><strong>{acceptedProposalIds.size}</strong> of {faceProposals.length} proposals selected</span><button className="primary" disabled={busy || !acceptedProposalIds.size} onClick={createFaceDerivatives}>Add selected derivatives</button></div></>}
    </section>

    <section className="panel stack">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 3B</p><div className="card-title">Manual Derivatives</div><p className="muted">Create a derivative from the active image. Drag the box to move it; drag a corner to resize while preserving the requested aspect ratio.</p></div>{focusAsset && <div className="image-stepper"><button onClick={() => stepFocus(-1)}>‹</button><span>{focusIndex + 1} / {includedAssets.length}</span><button onClick={() => stepFocus(1)}>›</button><strong>{focusAsset.filename}</strong></div>}</div>
      <label>Derivative aspect<select value={manualAspect} onChange={(event) => setManualAspect(event.target.value)}>{DERIVATIVE_ASPECTS.map((aspect) => <option key={aspect}>{aspect}</option>)}</select></label>
      {focusImage && focusAsset && <ManualCropEditor imageUrl={focusImage.image_url} filename={focusAsset.filename} aspect={manualAspect} busy={busy} onCreate={addManualDerivative} />}
    </section>

    <section className="panel stack training-resolution-panel">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 4 · Trainer policy</p><div className="card-title">Maximum Training Resolution</div><p className="muted">This is a maximum pixel budget, not a Krea-native image size. Fizgig groups compatible aspect ratios into trainer buckets and never enlarges source detail when no-upscale is enabled.</p></div><span className="badge">{modelFamily === "krea2" ? "Krea 2" : "Klein"}</span></div>
      <div className="segmented">{MP_PRESETS.map((mp) => <button key={mp} className={resolutionDraft.max_megapixels === mp ? "selected" : ""} onClick={() => setResolutionDraft({ ...resolutionDraft, max_megapixels: mp })}>{mp} MP</button>)}</div>
      <div className="form-row"><label>Custom maximum MP<input type="number" min="0.05" max="8" step="0.05" value={resolutionDraft.max_megapixels} onChange={(event) => setResolutionDraft({ ...resolutionDraft, max_megapixels: Number(event.target.value) })} /></label><label className="inline-check"><input type="checkbox" checked={resolutionDraft.enable_bucket} onChange={(event) => setResolutionDraft({ ...resolutionDraft, enable_bucket: event.target.checked })} /> Aspect-ratio bucketing</label><label className="inline-check"><input type="checkbox" checked={resolutionDraft.bucket_no_upscale} onChange={(event) => setResolutionDraft({ ...resolutionDraft, bucket_no_upscale: event.target.checked })} /> Never upscale source detail</label></div>
      <div className="summary-grid"><div><span>Needs downscale</span><strong>{downscaled}</strong></div><div><span>No downscale</span><strong>{unchanged}</strong></div><div><span>Low-detail warnings</span><strong>{lowDetail}</strong></div></div>
      <button className="primary" disabled={busy || !resolutionDirty} onClick={saveResolution}>{resolutionDirty ? "Save training resolution policy" : "Training resolution saved"}</button>
      <BucketPreview rows={resolutionRows} assets={includedAssets} onReviewCrop={reviewCrop} />
      <div className="prep-grid resolution-cards">{resolutionRows.map((row) => { const image = dataset.images.find((item) => item.filename === row.filename); const asset = includedAssets.find((item) => item.filename === row.filename); if (!image) return null; const cropped = cropLoss(row) > 0.005; const kind = asset?.asset_kind === "derived" ? "Derived" : "Source"; return <div className="prep-image-card" key={row.filename}><div className="prep-image-wrap hover-context"><img src={image.image_url} alt={row.filename} />{row.low_detail && <span className="derived-badge">Low detail</span>}</div><div className="prep-image-meta resolution-copy"><strong>{row.filename}</strong>{cropped ? <><span>{kind} {row.file_width}×{row.file_height} · {row.file_megapixels} MP</span><span>Composition → {row.crop_width}×{row.crop_height} · {row.crop_megapixels} MP</span></> : <span>{kind} {row.crop_width}×{row.crop_height} · {row.crop_megapixels} MP</span>}<span className={row.low_detail ? "status-suspect" : "status-good"}>Expected trainer bucket → {row.bucket_width}×{row.bucket_height} · {row.bucket_megapixels} MP</span><small>{row.direction === "downscale" ? "Downscale" : row.direction === "upscale" ? "Upscale requested" : "No downscale"}{row.low_detail ? " · below half the selected pixel budget" : ""}</small></div></div>; })}</div>
    </section>

    <section className="panel stack" id="per-image-exceptions">
      <div className="prep-section-heading"><div><p className="eyebrow">Stage 5</p><div className="card-title">Per-image Exceptions & Crop Review</div><p className="muted">Use this for an image that needs different framing or tonal adjustment. Bucket Preview links here when a composition crop removes more than 5% of the source pixels.</p></div><span className="muted">{includedAssets.length} working images</span></div>
      <div className="processed-grid">{includedAssets.map((asset) => { const image = dataset.images.find((item) => item.filename === asset.filename); if (!image) return null; const active = editName === asset.filename; const overrideCount = Object.keys(asset.transform_override || {}).length; return <div key={asset.filename} className="processed-grid-item"><button className={`processed-card ${active ? "selected" : ""}`} onClick={() => openEditor(asset.filename)}><div className="processed-image fixed-review-card"><img src={image.image_url} alt={asset.filename} /></div><div className="prep-image-meta"><strong>{asset.filename}</strong><span>{overrideCount ? `${overrideCount} override${overrideCount === 1 ? "" : "s"}` : "Global recipe"}</span></div></button>{active && <div className="inline-image-editor"><div className="inline-editor-preview live-crop-preview" style={{ aspectRatio: overrideDraft.aspect_ratio && overrideDraft.aspect_ratio !== "source" ? aspectNumber(overrideDraft.aspect_ratio) : undefined }}><img src={image.image_url} alt={asset.filename} style={{ objectPosition: `${((overrideDraft.crop_x ?? globalDraft.crop_x ?? 0.5) * 100)}% ${((overrideDraft.crop_y ?? globalDraft.crop_y ?? 0.5) * 100)}%`, objectFit: overrideDraft.aspect_ratio && overrideDraft.aspect_ratio !== "source" ? "cover" : "contain", filter: `brightness(${Math.max(0, 1 + (overrideDraft.brightness ?? globalDraft.brightness ?? 0))}) contrast(${Math.max(0, 1 + (overrideDraft.contrast ?? globalDraft.contrast ?? 0))})` }} /></div><div className="stack inline-editor-controls"><div><p className="eyebrow">Per-image exception</p><div className="card-title">{asset.filename}</div></div><label>Aspect<select value={overrideDraft.aspect_ratio ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, aspect_ratio: event.target.value || undefined })}><option value="">Inherit {targetAspect}</option>{ASPECTS.map((aspect) => <option key={aspect} value={aspect}>{aspect === "source" ? "Source / no crop" : aspect}</option>)}</select></label><label>Crop horizontal<input type="range" min="0" max="1" step="0.01" value={overrideDraft.crop_x ?? globalDraft.crop_x ?? 0.5} onChange={(event) => setOverrideDraft({ ...overrideDraft, crop_x: Number(event.target.value) })} /></label><label>Crop vertical<input type="range" min="0" max="1" step="0.01" value={overrideDraft.crop_y ?? globalDraft.crop_y ?? 0.5} onChange={(event) => setOverrideDraft({ ...overrideDraft, crop_y: Number(event.target.value) })} /></label><div className="form-row"><label>Exposure<input type="number" step="0.1" value={overrideDraft.exposure ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, exposure: event.target.value === "" ? undefined : Number(event.target.value) })} /></label><label>Brightness<input type="number" step="0.05" value={overrideDraft.brightness ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, brightness: event.target.value === "" ? undefined : Number(event.target.value) })} /></label></div><div className="form-row"><label>Contrast<input type="number" step="0.05" value={overrideDraft.contrast ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, contrast: event.target.value === "" ? undefined : Number(event.target.value) })} /></label><label>Gamma<input type="number" min="0.1" step="0.05" value={overrideDraft.gamma ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, gamma: event.target.value === "" ? undefined : Number(event.target.value) })} /></label></div><div className="actions"><button className="secondary" onClick={resetOverride} disabled={busy || !Object.keys(asset.transform_override || {}).length}>Reset to global</button><button className="primary" onClick={saveOverride} disabled={busy || !overrideDirty}>{overrideDirty ? "Save image override" : "Image override saved"}</button></div></div></div>}</div>; })}</div>
      <div className="actions"><button className="primary" disabled={!included} onClick={() => navigate("/captions")}>Continue to Captions →</button></div>
    </section>
  </div>;
}
