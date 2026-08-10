import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  acceptFaceCrops,
  createManualCrop,
  getImagePrepState,
  getProjectRevision,
  inspectDataset,
  proposeFaceCrops,
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
const MP_PRESETS = [0.25, 0.5, 0.75, 1, 1.5];

function aspectNumber(value: string, fallback = 1) {
  if (value === "source") return fallback;
  const [w, h] = value.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : fallback;
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function bucketKey(row: ResolutionAsset) {
  return `${row.bucket_width}×${row.bucket_height}`;
}

function bucketCount(rows: ResolutionAsset[]) {
  return new Set(rows.map(bucketKey)).size;
}

function cropLoss(row: ResolutionAsset) {
  return Math.max(0, 1 - (row.crop_width * row.crop_height) / Math.max(1, row.file_width * row.file_height));
}

function mergedTransform(globalTransform: ImageTransform, asset: ProjectAsset) {
  return { ...globalTransform, ...(asset.transform_override || {}) };
}

function previewFilter(transform: ImageTransform) {
  const exposure = transform.exposure ?? 0;
  const brightness = transform.brightness ?? 0;
  const contrast = transform.contrast ?? 0;
  const gamma = transform.gamma ?? 1;
  const gammaPreview = Math.pow(1.18, 1 - gamma);
  return `brightness(${Math.max(0, (1 + brightness) * Math.pow(2, exposure) * gammaPreview)}) contrast(${Math.max(0, 1 + contrast)})`;
}

function transformSummary(transform: ImageTransform, inherited?: ImageTransform) {
  const base = inherited || {};
  const bits: string[] = [];
  const aspect = transform.aspect_ratio;
  if (aspect && aspect !== (base.aspect_ratio || "source")) bits.push(`aspect ${aspect}`);
  const values: Array<[keyof ImageTransform, string, number]> = [
    ["exposure", "exp", 0],
    ["brightness", "bright", 0],
    ["contrast", "contrast", 0],
    ["gamma", "gamma", 1],
  ];
  for (const [key, label, fallback] of values) {
    const value = transform[key] as number | undefined;
    const inheritedValue = (base[key] as number | undefined) ?? fallback;
    if (value !== undefined && Math.abs(value - inheritedValue) > 1e-6) bits.push(`${label} ${value > 0 && key !== "gamma" ? "+" : ""}${Number(value).toFixed(key === "exposure" ? 1 : 2)}`);
  }
  if ((transform.crop_scale ?? 1) < 0.999) bits.push(`crop ${Math.round((transform.crop_scale ?? 1) * 100)}%`);
  return bits;
}

function SliderField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const precision = String(step).includes(".") ? String(step).split(".")[1].length : 0;
  const clamp = (v: number) => Math.max(min, Math.min(max, Number(v.toFixed(precision))));
  return (
    <label className="tuning-slider">
      <span className="slider-title"><span>{label}</span><strong>{value.toFixed(precision)}</strong></span>
      <span className="slider-row">
        <button type="button" className="micro-button" onClick={() => onChange(clamp(value - step))}>−</button>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
        <button type="button" className="micro-button" onClick={() => onChange(clamp(value + step))}>+</button>
      </span>
    </label>
  );
}

function cropFromCenter(aspect: string, imageWidth: number, imageHeight: number, scale = 0.8): CropRect {
  const sourceAspect = imageWidth / Math.max(1, imageHeight);
  const target = aspectNumber(aspect, sourceAspect);
  let baseW = 1;
  let baseH = 1;
  if (sourceAspect >= target) baseW = target / sourceAspect;
  else baseH = sourceAspect / target;
  const width = baseW * scale;
  const height = baseH * scale;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

function clampCrop(rect: CropRect, aspect: string, imageWidth: number, imageHeight: number): CropRect {
  const sourceAspect = imageWidth / Math.max(1, imageHeight);
  const target = aspectNumber(aspect, sourceAspect);
  let width = Math.max(0.04, Math.min(1, rect.width));
  let height = (width * sourceAspect) / target;
  if (height > 1) {
    height = 1;
    width = (height * target) / sourceAspect;
  }
  return {
    x: Math.max(0, Math.min(1 - width, rect.x)),
    y: Math.max(0, Math.min(1 - height, rect.y)),
    width,
    height,
  };
}

function ManualCropEditor({ imageUrl, filename, aspect, onCreate, busy }: { imageUrl: string; filename: string; aspect: string; onCreate: (crop: CropRect) => void; busy: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ width: 1, height: 1 });
  const [crop, setCrop] = useState<CropRect>(() => cropFromCenter(aspect, 1, 1));
  const [drag, setDrag] = useState<{ mode: DragMode; x: number; y: number; start: CropRect } | null>(null);

  useEffect(() => setCrop(cropFromCenter(aspect, dims.width, dims.height)), [aspect, dims.width, dims.height, filename]);

  function point(event: React.PointerEvent) {
    const bounds = ref.current!.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  }

  function begin(event: React.PointerEvent, mode: DragMode) {
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event); setDrag({ mode, x: p.x, y: p.y, start: crop });
  }

  function move(event: React.PointerEvent) {
    if (!drag) return;
    const p = point(event); const dx = p.x - drag.x; const dy = p.y - drag.y;
    if (drag.mode === "move") {
      setCrop(clampCrop({ ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy }, aspect, dims.width, dims.height));
      return;
    }
    const sign = drag.mode?.includes("w") ? -1 : 1;
    const width = Math.max(0.04, drag.start.width + dx * sign);
    const right = drag.start.x + drag.start.width;
    const bottom = drag.start.y + drag.start.height;
    let next = clampCrop({ x: drag.mode?.includes("w") ? right - width : drag.start.x, y: drag.start.y, width, height: drag.start.height }, aspect, dims.width, dims.height);
    if (drag.mode?.includes("n")) next = clampCrop({ ...next, y: bottom - next.height }, aspect, dims.width, dims.height);
    setCrop(next);
  }

  const pxW = Math.max(1, Math.round(crop.width * dims.width));
  const pxH = Math.max(1, Math.round(crop.height * dims.height));

  return (
    <div className="manual-editor-shell">
      <div ref={ref} className="manual-crop-canvas" style={{ aspectRatio: `${dims.width}/${dims.height}` }} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
        <img src={imageUrl} alt={filename} draggable={false} onLoad={(event) => setDims({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
        <div className="manual-source-size">Source {dims.width}×{dims.height}</div>
        <div className="interactive-crop-box" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={(event) => begin(event, "move")}>
          <span className="crop-size-label">{pxW}×{pxH} · {((pxW * pxH) / 1e6).toFixed(2)} MP</span>
          {(["nw", "ne", "sw", "se"] as const).map((corner) => <span key={corner} className={`crop-handle ${corner}`} onPointerDown={(event) => begin(event, corner)} />)}
        </div>
      </div>
      <button className="primary" disabled={busy} onClick={() => onCreate(crop)}>Create {aspect} derivative</button>
    </div>
  );
}

function cropGeometry(width: number, height: number, aspect: string, scale: number, cropX: number, cropY: number): CropRect {
  if (aspect === "source") return { x: 0, y: 0, width: 1, height: 1 };
  const source = width / Math.max(1, height);
  const target = aspectNumber(aspect, source);
  let baseW = 1;
  let baseH = 1;
  if (source >= target) baseW = target / source;
  else baseH = source / target;
  const w = baseW * scale;
  const h = baseH * scale;
  return { x: (1 - w) * cropX, y: (1 - h) * cropY, width: w, height: h };
}

function PositionCropEditor({ imageUrl, filename, aspect, scale, cropX, cropY, onChange, filter }: { imageUrl: string; filename: string; aspect: string; scale: number; cropX: number; cropY: number; onChange: (next: { x: number; y: number; scale: number }) => void; filter: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ width: 1, height: 1 });
  const [drag, setDrag] = useState<{ mode: DragMode; cx: number; cy: number; x: number; y: number; scale: number } | null>(null);
  const crop = cropGeometry(dims.width, dims.height, aspect, scale, cropX, cropY);
  const pxW = Math.round(crop.width * dims.width);
  const pxH = Math.round(crop.height * dims.height);

  function begin(event: React.PointerEvent, mode: DragMode) {
    if (aspect === "source") return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ mode, cx: event.clientX, cy: event.clientY, x: cropX, y: cropY, scale });
  }

  function move(event: React.PointerEvent) {
    if (!drag || !ref.current || aspect === "source") return;
    const bounds = ref.current.getBoundingClientRect();
    const dx = (event.clientX - drag.cx) / bounds.width;
    const dy = (event.clientY - drag.cy) / bounds.height;
    if (drag.mode === "move") {
      onChange({
        x: Math.max(0, Math.min(1, drag.x + dx / Math.max(0.001, 1 - crop.width))),
        y: Math.max(0, Math.min(1, drag.y + dy / Math.max(0.001, 1 - crop.height))),
        scale: drag.scale,
      });
      return;
    }
    const sx = drag.mode?.includes("w") ? -dx : dx;
    const sy = drag.mode?.includes("n") ? -dy : dy;
    const delta = Math.abs(sx) > Math.abs(sy) ? sx : sy;
    onChange({ x: drag.x, y: drag.y, scale: Math.max(0.1, Math.min(1, drag.scale + delta * 2)) });
  }

  return (
    <div className="position-crop-shell">
      <div ref={ref} className="position-crop-canvas" style={{ aspectRatio: `${dims.width}/${dims.height}` }} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
        <img src={imageUrl} alt={filename} draggable={false} style={{ filter }} onLoad={(event) => setDims({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
        {aspect !== "source" ? (
          <div className="position-crop-box" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={(event) => begin(event, "move")}>
            <span>{pxW}×{pxH} · {((pxW * pxH) / 1e6).toFixed(2)} MP</span>
            {(["nw", "ne", "sw", "se"] as const).map((corner) => <i key={corner} className={`crop-handle ${corner}`} onPointerDown={(event) => begin(event, corner)} />)}
          </div>
        ) : <div className="position-crop-full-label">Full source · {dims.width}×{dims.height}</div>}
      </div>
      <small>{aspect === "source" ? "No composition crop." : "Drag the window to reposition it; drag a corner to resize it."}</small>
    </div>
  );
}

function FaceProposalCard({ proposal, imageUrl, selected, onToggle }: { proposal: FaceCropProposal; imageUrl: string; selected: boolean; onToggle: () => void }) {
  const [x1, y1, x2, y2] = proposal.crop_box;
  const cropW = x2 - x1; const cropH = y2 - y1; const mp = cropW * cropH / 1e6; const crop = proposal.normalized_crop;
  return (
    <button className={`prep-image-card face-proposal-card ${selected ? "selected" : ""}`} onClick={onToggle}>
      <div className="face-proposal-native" style={{ aspectRatio: `${proposal.source_width}/${proposal.source_height}` }}>
        <img src={imageUrl} alt={proposal.filename} />
        <div className="face-crop-box" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} />
      </div>
      <div className="prep-image-meta">
        <strong>{proposal.filename}</strong>
        <span>Face {proposal.face_index + 1} · score {proposal.score}</span>
        <span>{proposal.aspect_ratio} · {proposal.padding_percent}% padding</span>
        <span className={mp < 0.5 ? "status-suspect" : "status-good"}>Crop {cropW}×{cropH} · {mp.toFixed(2)} MP</span>
      </div>
    </button>
  );
}

function BucketPreview({ rows, onReview }: { rows: ResolutionAsset[]; onReview: (filename: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of rows) map.set(bucketKey(row), [...(map.get(bucketKey(row)) || []), row.filename]);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [rows]);
  const significant = rows.filter((row) => cropLoss(row) > 0.05);
  return (
    <div className="bucket-preview stack">
      <div className="prep-section-heading"><div><div className="card-title">Expected bucket groups</div><p className="muted">Preview only; exact trainer assignments are confirmed after caching.</p></div><div className="bucket-summary"><strong>{groups.length}</strong><span>groups</span><strong>{rows.length}</strong><span>images</span></div></div>
      <div className="bucket-group-grid">{groups.map(([key, names]) => <details className="bucket-group" key={key}><summary><strong>{key}</strong><span>{names.length} image{names.length === 1 ? "" : "s"}</span></summary><div className="bucket-file-list">{names.map((name) => <span key={name}>{name}</span>)}</div></details>)}</div>
      {significant.length > 0 && <div className="notice"><strong>{significant.length}</strong> image{significant.length === 1 ? "" : "s"} lose more than 5% to composition cropping.<div className="crop-review-actions">{significant.map((row) => <button className="secondary" key={row.filename} onClick={() => onReview(row.filename)}>Review {row.filename}</button>)}</div></div>}
    </div>
  );
}

export function ImagePrepWorkbenchPageV4() {
  const navigate = useNavigate();
  const { project, revision, setRevision, dataset, setDataset, modelFamily } = useSession();
  const [prep, setPrep] = useState<ImagePrepState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [toastKind, setToastKind] = useState<"ok" | "warn" | "error">("ok");
  const [focusName, setFocusName] = useState("");
  const [editName, setEditName] = useState("");
  const [globalDraft, setGlobalDraft] = useState<ImageTransform>({});
  const [resolutionDraft, setResolutionDraft] = useState<TrainingResolutionPolicy>({ max_megapixels: 1, enable_bucket: true, bucket_no_upscale: true, dimension_step: 16 });
  const [overrideDraft, setOverrideDraft] = useState<ImageTransform>({});
  const [manualAspect, setManualAspect] = useState("1:1");
  const [faceAspect, setFaceAspect] = useState("1:1");
  const [facePadding, setFacePadding] = useState(60);
  const [faceProposals, setFaceProposals] = useState<FaceCropProposal[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  function notify(message: string, kind: "ok" | "warn" | "error" = "ok") {
    setToast(""); requestAnimationFrame(() => { setToastKind(kind); setToast(message); });
  }

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 5000); return () => clearTimeout(timer); }, [toast]);

  async function load() {
    if (!project || !revision) return;
    const state = await getImagePrepState(project.id, revision.id);
    setPrep(state); setGlobalDraft(state.global_transform); setResolutionDraft(state.training_resolution);
    const first = state.assets.find((asset) => asset.included !== false)?.filename || "";
    setFocusName((current) => current || first);
  }
  useEffect(() => { load().catch((error) => notify(error instanceof Error ? error.message : "Unable to load prep", "error")); }, [project, revision?.id]);

  const assets = prep?.assets ?? revision?.assets ?? [];
  const included = assets.filter((asset) => asset.included !== false);
  const sources = assets.filter((asset) => asset.asset_kind !== "derived");
  const workingSources = included.filter((asset) => asset.asset_kind !== "derived");
  const derivatives = included.filter((asset) => asset.asset_kind === "derived");
  const faceDerived = derivatives.filter((asset) => asset.origin === "face");
  const manualDerived = derivatives.filter((asset) => asset.origin === "manual");
  const sourceOverrides = workingSources.filter((asset) => Object.keys(asset.transform_override || {}).length > 0);
  const derivedOverrides = derivatives.filter((asset) => transformSummary(asset.transform_override || {}, {}).length > 0);
  const rows = prep?.resolution_assets ?? [];
  const visibleSources = sources.filter((asset) => filter === "all" ? true : filter === "included" ? asset.included !== false : asset.included === false);
  const focus = included.find((asset) => asset.filename === focusName) ?? included[0];
  const focusImage = dataset?.images.find((image) => image.filename === focus?.filename);
  const focusIndex = focus ? included.findIndex((asset) => asset.filename === focus.filename) : -1;
  const editAsset = included.find((asset) => asset.filename === editName);
  const globalDirty = !sameJson(globalDraft, prep?.global_transform);
  const resolutionDirty = !sameJson(resolutionDraft, prep?.training_resolution);
  const overrideDirty = !sameJson(overrideDraft, editAsset?.transform_override ?? {});
  const targetAspect = globalDraft.aspect_ratio || "source";

  async function refresh() {
    if (!project || !revision) return null;
    const nextRevision = await getProjectRevision(project.id, revision.id);
    setRevision(nextRevision);
    const state = await getImagePrepState(project.id, revision.id);
    setPrep(state); setGlobalDraft(state.global_transform); setResolutionDraft(state.training_resolution);
    setDataset(await inspectDataset(nextRevision.files_path));
    return state;
  }

  function toggle(filename: string) { setSelected((current) => { const next = new Set(current); next.has(filename) ? next.delete(filename) : next.add(filename); return next; }); }

  async function inclusion(value: boolean) {
    if (!project || !revision || !selected.size) return;
    setBusy(true); try { await setImageInclusion(project.id, revision.id, [...selected], value); setSelected(new Set()); await refresh(); notify(`${selected.size} source image(s) ${value ? "included" : "excluded"}.`); } finally { setBusy(false); }
  }

  async function all(value: boolean) {
    if (!project || !revision) return;
    setBusy(true); try { await setImageInclusion(project.id, revision.id, sources.map((asset) => asset.filename), value); setSelected(new Set()); await refresh(); notify(value ? "All source images included." : "All source images excluded."); } finally { setBusy(false); }
  }

  function step(delta: number) { if (!included.length) return; setFocusName(included[(focusIndex + delta + included.length) % included.length].filename); }

  async function saveGlobal() {
    if (!project || !revision || !globalDirty) return;
    const before = bucketCount(rows); setBusy(true);
    try { const state = await setGlobalImageTransform(project.id, revision.id, globalDraft); setPrep(state); setGlobalDraft(state.global_transform); const after = bucketCount(state.resolution_assets); notify(after !== before ? `Bucket layout changed: ${before} → ${after} expected groups.` : "Base composition saved.", after !== before ? "warn" : "ok"); } finally { setBusy(false); }
  }

  async function saveResolution() {
    if (!project || !revision || !resolutionDirty) return;
    const before = bucketCount(rows); setBusy(true);
    try { const state = await setTrainingResolution(project.id, revision.id, resolutionDraft); setPrep(state); setResolutionDraft(state.training_resolution); const after = bucketCount(state.resolution_assets); notify(after !== before ? `Bucket layout changed: ${before} → ${after} expected groups.` : "Training resolution saved.", after !== before ? "warn" : "ok"); } finally { setBusy(false); }
  }

  async function addManual(crop: CropRect) {
    if (!project || !revision || !focus) return;
    setBusy(true); try { const result = await createManualCrop(project.id, revision.id, focus.filename, manualAspect, crop); await refresh(); setFocusName(result.asset.filename); notify(`Manual ${manualAspect} derivative created.`); } finally { setBusy(false); }
  }

  async function detect() {
    if (!project || !revision) return;
    setBusy(true); try { const names = selected.size ? [...selected].filter((name) => workingSources.some((asset) => asset.filename === name)) : workingSources.map((asset) => asset.filename); const result = await proposeFaceCrops(project.id, revision.id, names, faceAspect, facePadding); setFaceProposals(result.proposals); setAccepted(new Set(result.proposals.map((proposal) => proposal.id))); notify(`${result.proposals.length} face proposal(s) ready.`); } catch (error) { notify(error instanceof Error ? error.message : "Face detection failed", "error"); } finally { setBusy(false); }
  }

  async function addFaces() {
    if (!project || !revision) return;
    const chosen = faceProposals.filter((proposal) => accepted.has(proposal.id)); if (!chosen.length) return;
    setBusy(true); try { const result = await acceptFaceCrops(project.id, revision.id, chosen); setFaceProposals([]); setAccepted(new Set()); await refresh(); notify(`${result.assets.length} face derivative(s) added.`); } finally { setBusy(false); }
  }

  function openEditor(filename: string) {
    const asset = included.find((candidate) => candidate.filename === filename); if (!asset) return;
    if (editName === filename) { setEditName(""); return; }
    setEditName(filename); setFocusName(filename); setOverrideDraft(asset.transform_override || {});
  }

  function review(filename: string) { openEditor(filename); requestAnimationFrame(() => document.getElementById("per-image-v4")?.scrollIntoView({ behavior: "smooth", block: "start" })); }

  async function saveOverride() {
    if (!project || !revision || !editAsset || !overrideDirty) return;
    const before = bucketCount(rows); setBusy(true);
    try { const state = await setAssetImageTransform(project.id, revision.id, editAsset.filename, overrideDraft); setPrep(state); const after = bucketCount(state.resolution_assets); await refresh(); notify(after !== before ? `Bucket layout changed: ${before} → ${after} expected groups after ${editAsset.filename}.` : `${editAsset.filename} override saved.`, after !== before ? "warn" : "ok"); } finally { setBusy(false); }
  }

  async function resetOverride() {
    if (!project || !revision || !editAsset) return;
    setBusy(true); try { await setAssetImageTransform(project.id, revision.id, editAsset.filename, {}); setOverrideDraft({}); await refresh(); notify("Image override reset."); } finally { setBusy(false); }
  }

  if (!project || !revision || !dataset) return <section className="panel"><h1>Image Prep</h1><p>Open a project first.</p></section>;

  const down = rows.filter((row) => row.direction === "downscale").length;
  const preserved = rows.filter((row) => row.direction === "native").length;
  const low = rows.filter((row) => row.low_detail).length;
  const cropReview = rows.filter((row) => cropLoss(row) > 0.05).length;
  const groups = [...new Set(rows.map(bucketKey))];
  const missing = included.filter((asset) => !asset.caption.trim()).length;

  return (
    <div className="stack image-prep-page image-prep-v3 image-prep-v4">
      {toast && <div className={`prep-toast ${toastKind}`}>{toast}</div>}
      <header className="page-header">
        <div><p className="eyebrow">{project.name} · {project.id} · {revision.name}</p><h1>Build the Training Dataset</h1><p className="muted">Source assets stay distinct from project-created derivatives and image exceptions.</p></div>
        <div className="prep-counts provenance-counts"><span><strong>{sources.length}</strong> sources</span><span className="status-good"><strong>{included.length}</strong> working</span><span><strong>{derivatives.length}</strong> derived</span><span><strong>{sourceOverrides.length + derivedOverrides.length}</strong> adjusted</span></div>
      </header>

      <section className="panel stack">
        <div className="prep-section-heading"><div><p className="eyebrow">Stage 1</p><div className="card-title">Working Assets</div><p className="muted">Choose source images for this project. Excluded sources dim immediately; hover a card to see the complete source. Derivatives are tracked separately.</p></div><div className="actions"><button className="secondary" onClick={() => all(true)}>Include all sources</button><button className="secondary" onClick={() => all(false)}>Exclude all sources</button></div></div>
        <div className="segmented"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All {sources.length}</button><button className={filter === "included" ? "selected" : ""} onClick={() => setFilter("included")}>Working {workingSources.length}</button><button className={filter === "excluded" ? "selected" : ""} onClick={() => setFilter("excluded")}>Excluded {sources.length - workingSources.length}</button></div>
        <div className="asset-subheading">Source assets <span>{visibleSources.length}</span></div>
        <div className="prep-grid">{visibleSources.map((asset) => { const image = dataset.images.find((candidate) => candidate.filename === asset.filename); if (!image) return null; return <div className={`prep-image-card ${focusName === asset.filename ? "focused" : ""} ${asset.included === false ? "excluded" : ""}`} key={asset.filename}><button className="prep-focus-button" onClick={() => setFocusName(asset.filename)}><div className="prep-image-wrap"><img src={image.image_url} alt={asset.filename} /></div><div className="prep-image-meta"><strong>{asset.filename}</strong></div></button><button className={`batch-check ${selected.has(asset.filename) ? "checked" : ""}`} onClick={() => toggle(asset.filename)}>{selected.has(asset.filename) ? "✓" : ""}</button></div>; })}</div>
        {derivatives.length > 0 && <><div className="asset-subheading">Project derivatives <span>{faceDerived.length} face · {manualDerived.length} manual</span></div><div className="prep-grid derivative-grid">{derivatives.map((asset) => { const image = dataset.images.find((candidate) => candidate.filename === asset.filename); if (!image) return null; const changes = transformSummary(asset.transform_override || {}, {}); return <button className={`prep-image-card ${focusName === asset.filename ? "focused" : ""}`} key={asset.filename} onClick={() => setFocusName(asset.filename)}><div className="prep-image-wrap"><img src={image.image_url} alt={asset.filename} style={{ filter: previewFilter(asset.transform_override || {}) }} />{changes.length > 0 && <span className="transform-badge">Adjusted</span>}<span className="derived-badge">{asset.origin === "face" ? "Face" : "Manual"}</span></div><div className="prep-image-meta"><strong>{asset.filename}</strong><span>Parent: {asset.parent_filename || "source asset"}</span>{changes.length > 0 && <span className="transform-state-line"><span className="changed">{changes.join(" · ")}</span></span>}</div></button>; })}</div></>}
        {selected.size > 0 && <div className="selection-bar"><span><strong>{selected.size}</strong> source image(s) selected</span><div className="actions"><button className="secondary" onClick={() => inclusion(false)}>Exclude</button><button className="primary" onClick={() => inclusion(true)}>Include</button></div></div>}
      </section>

      <section className="panel stack">
        <div className="prep-section-heading"><div><p className="eyebrow">Stage 2</p><div className="card-title">Base Composition & Adjustments</div><p className="muted">Global settings apply to source assets unless an image has an explicit exception.</p></div>{focus && <div className="image-stepper"><button onClick={() => step(-1)}>‹</button><span>{focusIndex + 1} / {included.length}</span><button onClick={() => step(1)}>›</button><strong title={focus.filename}>{focus.filename}</strong></div>}</div>
        {focusImage && focus && <div className="composition-preview-row"><div className="composition-preview"><img src={focusImage.image_url} alt={focus.filename} style={{ filter: previewFilter(globalDraft) }} /></div><div className="stack"><div className="form-row"><label>Base aspect<select value={targetAspect} onChange={(event) => setGlobalDraft({ ...globalDraft, aspect_ratio: event.target.value, crop_mode: event.target.value === "source" ? "fit" : "fill" })}>{ASPECTS.map((aspect) => <option key={aspect} value={aspect}>{aspect === "source" ? "Source / no crop" : aspect}</option>)}</select></label><label>Crop mode<select disabled={targetAspect === "source"} value={targetAspect === "source" ? "fit" : globalDraft.crop_mode ?? "fill"} onChange={(event) => setGlobalDraft({ ...globalDraft, crop_mode: event.target.value as "fill" | "fit" })}><option value="fill">Fill / crop</option><option value="fit">Fit / no crop</option></select></label></div><div className="tuning-grid"><SliderField label="Exposure" min={-2} max={2} step={0.1} value={globalDraft.exposure ?? 0} onChange={(value) => setGlobalDraft({ ...globalDraft, exposure: value })} /><SliderField label="Brightness" min={-0.5} max={0.5} step={0.05} value={globalDraft.brightness ?? 0} onChange={(value) => setGlobalDraft({ ...globalDraft, brightness: value })} /><SliderField label="Contrast" min={-0.5} max={0.5} step={0.05} value={globalDraft.contrast ?? 0} onChange={(value) => setGlobalDraft({ ...globalDraft, contrast: value })} /><SliderField label="Gamma" min={0.5} max={1.5} step={0.05} value={globalDraft.gamma ?? 1} onChange={(value) => setGlobalDraft({ ...globalDraft, gamma: value })} /></div></div></div>}
        <button className="primary" disabled={busy || !globalDirty} onClick={saveGlobal}>{globalDirty ? "Save base composition recipe" : "Base composition saved"}</button>
      </section>

      <section className="panel stack"><div className="prep-section-heading"><div><p className="eyebrow">Stage 3A</p><div className="card-title">Automatic Face Derivatives</div><p className="muted">Crops are exact requested aspect ratios in source pixels; low-resolution proposals are called out.</p></div></div><div className="form-row"><label>Derivative aspect<select value={faceAspect} onChange={(event) => setFaceAspect(event.target.value)}>{DERIVATIVE_ASPECTS.map((aspect) => <option key={aspect}>{aspect}</option>)}</select></label><label>Face padding %<input type="number" min="0" max="400" step="10" value={facePadding} onChange={(event) => setFacePadding(Number(event.target.value))} /></label><button className="secondary" disabled={busy || !workingSources.length} onClick={detect}>Detect faces & propose crops</button></div>{faceProposals.length > 0 && <><div className="prep-grid face-proposal-grid">{faceProposals.map((proposal) => { const image = dataset.images.find((candidate) => candidate.filename === proposal.filename); return image ? <FaceProposalCard key={proposal.id} proposal={proposal} imageUrl={image.image_url} selected={accepted.has(proposal.id)} onToggle={() => setAccepted((current) => { const next = new Set(current); next.has(proposal.id) ? next.delete(proposal.id) : next.add(proposal.id); return next; })} /> : null; })}</div><div className="selection-bar face-selection-bar"><div className="actions"><button className="secondary" onClick={() => setAccepted(new Set(faceProposals.map((proposal) => proposal.id)))}>Select all</button><button className="secondary" onClick={() => setAccepted(new Set())}>Deselect all</button></div><span><strong>{accepted.size}</strong> of {faceProposals.length} selected</span><button className="primary" disabled={!accepted.size || busy} onClick={addFaces}>Add selected derivatives</button></div></>}</section>

      <section className="panel stack"><div className="prep-section-heading"><div><p className="eyebrow">Stage 3B</p><div className="card-title">Manual Derivatives</div><p className="muted">Move and resize an exact-aspect crop directly over the active image.</p></div></div><label>Derivative aspect<select value={manualAspect} onChange={(event) => setManualAspect(event.target.value)}>{DERIVATIVE_ASPECTS.map((aspect) => <option key={aspect}>{aspect}</option>)}</select></label>{focusImage && focus && <ManualCropEditor imageUrl={focusImage.image_url} filename={focus.filename} aspect={manualAspect} busy={busy} onCreate={addManual} />}</section>

      <section className="panel stack training-resolution-panel"><div className="prep-section-heading"><div><p className="eyebrow">Stage 4 · Trainer policy</p><div className="card-title">Maximum Training Resolution</div><p className="muted">One maximum pixel budget, aspect bucketing, and downscale-only by default.</p></div><span className="badge">{modelFamily === "krea2" ? "Krea 2" : "Klein"}</span></div><div className="segmented">{MP_PRESETS.map((mp) => <button key={mp} className={resolutionDraft.max_megapixels === mp ? "selected" : ""} onClick={() => setResolutionDraft({ ...resolutionDraft, max_megapixels: mp })}>{mp} MP</button>)}</div><div className="form-row"><label>Custom maximum MP<input type="number" min=".05" max="8" step=".05" value={resolutionDraft.max_megapixels} onChange={(event) => setResolutionDraft({ ...resolutionDraft, max_megapixels: Number(event.target.value) })} /></label><label className="inline-check"><input type="checkbox" checked={resolutionDraft.enable_bucket} onChange={(event) => setResolutionDraft({ ...resolutionDraft, enable_bucket: event.target.checked })} /> Aspect-ratio bucketing</label><label className="inline-check"><input type="checkbox" checked={resolutionDraft.bucket_no_upscale} onChange={(event) => setResolutionDraft({ ...resolutionDraft, bucket_no_upscale: event.target.checked })} /> Never upscale source detail</label></div><button className="primary" disabled={busy || !resolutionDirty} onClick={saveResolution}>{resolutionDirty ? "Save training resolution policy" : "Training resolution saved"}</button><BucketPreview rows={rows} onReview={review} /></section>

      <section className="panel stack" id="per-image-v4">
        <div className="prep-section-heading"><div><p className="eyebrow">Stage 5</p><div className="card-title">Per-image Exceptions & Crop Review</div><p className="muted">Collapsed cards show the persisted effective adjustment. Open one to move/resize its crop or tune it further.</p></div><span className="muted">{included.length} working · {sourceOverrides.length} source overrides · {derivedOverrides.length} adjusted derivatives</span></div>
        <div className="processed-grid">{included.map((asset) => { const image = dataset.images.find((candidate) => candidate.filename === asset.filename); if (!image) return null; const active = editName === asset.filename; const isDerived = asset.asset_kind === "derived"; const effective = mergedTransform(globalDraft, asset); const explicitChanges = transformSummary(asset.transform_override || {}, isDerived ? {} : globalDraft); const cardLabel = isDerived ? `${asset.origin === "face" ? "Face" : "Manual"} derivative` : explicitChanges.length ? "Image override" : "Global recipe"; return <div className="processed-grid-item" key={asset.filename}><button className={`processed-card ${active ? "selected" : ""}`} onClick={() => openEditor(asset.filename)}><div className="processed-image fixed-review-card"><img src={image.image_url} alt={asset.filename} style={{ filter: previewFilter(effective) }} />{explicitChanges.length > 0 && <span className="transform-badge">Adjusted</span>}</div><div className="prep-image-meta"><strong>{asset.filename}</strong><span>{cardLabel}</span>{explicitChanges.length > 0 && <span className="transform-state-line"><span className="changed">{explicitChanges.join(" · ")}</span></span>}</div></button>{active && <div className="inline-image-editor crop-review-editor"><PositionCropEditor imageUrl={image.image_url} filename={asset.filename} aspect={overrideDraft.aspect_ratio ?? targetAspect} scale={overrideDraft.crop_scale ?? 1} cropX={overrideDraft.crop_x ?? globalDraft.crop_x ?? 0.5} cropY={overrideDraft.crop_y ?? globalDraft.crop_y ?? 0.5} filter={previewFilter({ ...globalDraft, ...overrideDraft })} onChange={(next) => setOverrideDraft({ ...overrideDraft, crop_x: next.x, crop_y: next.y, crop_scale: next.scale, crop_mode: "fill" })} /><div className="stack inline-editor-controls"><div><p className="eyebrow">Per-image exception</p><div className="card-title">{asset.filename}</div></div><label>Aspect<select value={overrideDraft.aspect_ratio ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, aspect_ratio: event.target.value || undefined, crop_x: 0.5, crop_y: 0.5, crop_scale: 1, crop_mode: event.target.value && event.target.value !== "source" ? "fill" : undefined })}><option value="">Inherit {targetAspect}</option>{ASPECTS.map((aspect) => <option key={aspect} value={aspect}>{aspect === "source" ? "Source / no crop" : aspect}</option>)}</select></label><div className="tuning-grid"><SliderField label="Exposure" min={-2} max={2} step={0.1} value={overrideDraft.exposure ?? globalDraft.exposure ?? 0} onChange={(value) => setOverrideDraft({ ...overrideDraft, exposure: value })} /><SliderField label="Brightness" min={-0.5} max={0.5} step={0.05} value={overrideDraft.brightness ?? globalDraft.brightness ?? 0} onChange={(value) => setOverrideDraft({ ...overrideDraft, brightness: value })} /><SliderField label="Contrast" min={-0.5} max={0.5} step={0.05} value={overrideDraft.contrast ?? globalDraft.contrast ?? 0} onChange={(value) => setOverrideDraft({ ...overrideDraft, contrast: value })} /><SliderField label="Gamma" min={0.5} max={1.5} step={0.05} value={overrideDraft.gamma ?? globalDraft.gamma ?? 1} onChange={(value) => setOverrideDraft({ ...overrideDraft, gamma: value })} /></div><div className="actions"><button className="secondary" onClick={resetOverride}>Reset to global</button><button className="primary" disabled={!overrideDirty || busy} onClick={saveOverride}>{overrideDirty ? "Save image override" : "Image override saved"}</button></div></div></div>}</div>; })}</div>
      </section>

      <section className="panel stack dataset-final-summary clean-summary"><div className="prep-section-heading"><div><p className="eyebrow">Review</p><div className="card-title">Training Dataset Summary</div><p className="muted">The effective project state that will carry forward into captioning.</p></div><span className="badge">{project.id}</span></div><div className="summary-ledger"><div><span>Working set</span><strong>{included.length} images</strong><small>{workingSources.length} source · {derivatives.length} derived</small></div><div><span>Derivatives</span><strong>{derivatives.length}</strong><small>{faceDerived.length} face · {manualDerived.length} manual</small></div><div><span>Adjusted images</span><strong>{sourceOverrides.length + derivedOverrides.length}</strong><small>{sourceOverrides.length} source overrides · {derivedOverrides.length} adjusted derivatives</small></div><div><span>Training resolution</span><strong>{resolutionDraft.max_megapixels.toFixed(2)} MP max</strong><small>{down} downscale · {preserved} preserved</small></div><div><span>Expected buckets</span><strong>{groups.length}</strong><small>{groups.map((group) => `${group} (${rows.filter((row) => bucketKey(row) === group).length})`).join(" · ") || "none"}</small></div><div><span>Crop review</span><strong>{cropReview}</strong><small>&gt;5% source area removed</small></div><div><span>Low detail</span><strong>{low}</strong><small>below half target budget</small></div><div><span>Need captions</span><strong>{missing}</strong><small>will surface next</small></div></div><div className="actions"><button className="primary" disabled={!included.length} onClick={() => navigate("/captions")}>Continue to Captions →</button></div></section>
    </div>
  );
}
