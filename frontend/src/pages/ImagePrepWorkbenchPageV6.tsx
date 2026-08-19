import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  acceptFaceCrops,
  createManualCrop,
  deleteDerivativeAsset,
  getImagePrepState,
  getProjectRevision,
  inspectDataset,
  preparedAssetPreviewUrl,
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
import {
  getManualCropPresets,
  importProjectImages,
  type ManualCropPreset,
} from "../image-prep-flow-api";
import { TrainingFilenamePolicyEditor } from "../components/TrainingFilenamePolicyEditor";
import { useSession } from "../session";

type AssetFilter = "all" | "included" | "excluded";
type ProcessingTool = "global" | "faces" | "manual" | "review";
type CropRect = { x: number; y: number; width: number; height: number };
type DragMode = "move" | "nw" | "ne" | "sw" | "se" | null;

const ASPECTS = ["source", "16:9", "1:1", "4:5", "5:4", "9:16"];
const DERIVATIVE_ASPECTS = ["1:1", "4:5", "5:4", "9:16", "16:9"];
const MP_PRESETS = [0.25, 0.5, 0.75, 1, 1.5];
const DEFAULT_GLOBAL: ImageTransform = {
  aspect_ratio: "source",
  crop_mode: "fit",
  crop_x: 0.5,
  crop_y: 0.5,
  crop_scale: 1,
  exposure: 0,
  brightness: 0,
  contrast: 0,
  gamma: 1,
};

function sameJson(a: unknown, b: unknown) { return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {}); }
function bucketKey(row: ResolutionAsset) { return `${row.bucket_width}×${row.bucket_height}`; }
function bucketCount(rows: ResolutionAsset[]) { return new Set(rows.map(bucketKey)).size; }
function cropLoss(row: ResolutionAsset) { return Math.max(0, 1 - (row.crop_width * row.crop_height) / Math.max(1, row.file_width * row.file_height)); }
function hasCompositionCrop(asset: ProjectAsset, row?: ResolutionAsset) {
  if (asset.asset_kind === "derived") return true;
  if (!row) return false;
  return row.crop_width !== row.file_width || row.crop_height !== row.file_height || cropLoss(row) > 0.001;
}
function aspectNumber(value: string, fallback = 1) {
  if (value === "source") return fallback;
  const [w, h] = value.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : fallback;
}
function derivativeBaseTransform(asset: ProjectAsset): ImageTransform {
  const operation = [...(asset.operations || [])].reverse().find((item) => item.type === "manual_crop" || item.type === "face_crop");
  const aspect = typeof operation?.aspect_ratio === "string" ? operation.aspect_ratio : "source";
  return { aspect_ratio: aspect, crop_mode: "fit", crop_x: 0.5, crop_y: 0.5, crop_scale: 1, exposure: 0, brightness: 0, contrast: 0, gamma: 1 };
}
function inheritedTransform(globalTransform: ImageTransform, asset: ProjectAsset): ImageTransform {
  return asset.baked_transform ? derivativeBaseTransform(asset) : globalTransform;
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
    if (value !== undefined && Math.abs(value - inheritedValue) > 1e-6) {
      bits.push(`${label} ${value > 0 && key !== "gamma" ? "+" : ""}${Number(value).toFixed(key === "exposure" ? 1 : 2)}`);
    }
  }
  if ((transform.crop_scale ?? 1) < 0.999) bits.push(`crop ${Math.round((transform.crop_scale ?? 1) * 100)}%`);
  return bits;
}
function tonalTransform(value: ImageTransform): ImageTransform {
  return {
    exposure: value.exposure ?? 0,
    brightness: value.brightness ?? 0,
    contrast: value.contrast ?? 0,
    gamma: value.gamma ?? 1,
  };
}
function legacyCompositionActive(value?: ImageTransform) {
  if (!value) return false;
  return (value.aspect_ratio ?? "source") !== "source" || (value.crop_mode ?? "fit") === "fill" || (value.crop_scale ?? 1) < 0.999;
}
function SliderField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const precision = String(step).includes(".") ? String(step).split(".")[1].length : 0;
  const clamp = (next: number) => Math.max(min, Math.min(max, Number(next.toFixed(precision))));
  return <label className="tuning-slider"><span className="slider-title"><span>{label}</span><strong>{value.toFixed(precision)}</strong></span><span className="slider-row"><button type="button" className="micro-button" onClick={() => onChange(clamp(value - step))}>−</button><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /><button type="button" className="micro-button" onClick={() => onChange(clamp(value + step))}>+</button></span></label>;
}
function cropGeometry(width: number, height: number, aspect: string, scale: number, cropX: number, cropY: number): CropRect {
  if (aspect === "source") return { x: 0, y: 0, width: 1, height: 1 };
  const source = width / Math.max(1, height);
  const target = aspectNumber(aspect, source);
  let baseW = 1, baseH = 1;
  if (source >= target) baseW = target / source; else baseH = source / target;
  const w = baseW * scale, h = baseH * scale;
  return { x: (1 - w) * cropX, y: (1 - h) * cropY, width: w, height: h };
}
function PositionCropEditor({ imageUrl, filename, aspect, scale, cropX, cropY, onChange, filter }: { imageUrl: string; filename: string; aspect: string; scale: number; cropX: number; cropY: number; onChange: (next: { x: number; y: number; scale: number }) => void; filter: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ width: 1, height: 1 });
  const [drag, setDrag] = useState<{ mode: DragMode; cx: number; cy: number; x: number; y: number; scale: number } | null>(null);
  const crop = cropGeometry(dims.width, dims.height, aspect, scale, cropX, cropY);
  const pxW = Math.round(crop.width * dims.width), pxH = Math.round(crop.height * dims.height);
  function begin(event: React.PointerEvent, mode: DragMode) {
    if (aspect === "source") return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ mode, cx: event.clientX, cy: event.clientY, x: cropX, y: cropY, scale });
  }
  function move(event: React.PointerEvent) {
    if (!drag || !ref.current || aspect === "source") return;
    const bounds = ref.current.getBoundingClientRect();
    const dx = (event.clientX - drag.cx) / bounds.width, dy = (event.clientY - drag.cy) / bounds.height;
    if (drag.mode === "move") {
      onChange({ x: Math.max(0, Math.min(1, drag.x + dx / Math.max(0.001, 1 - crop.width))), y: Math.max(0, Math.min(1, drag.y + dy / Math.max(0.001, 1 - crop.height))), scale: drag.scale });
      return;
    }
    const sx = drag.mode?.includes("w") ? -dx : dx, sy = drag.mode?.includes("n") ? -dy : dy;
    const delta = Math.abs(sx) > Math.abs(sy) ? sx : sy;
    onChange({ x: drag.x, y: drag.y, scale: Math.max(0.1, Math.min(1, drag.scale + delta * 2)) });
  }
  return <div className="position-crop-shell"><div ref={ref} className="position-crop-canvas" style={{ aspectRatio: `${dims.width}/${dims.height}` }} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}><img src={imageUrl} alt={filename} draggable={false} style={{ filter }} onLoad={(event) => setDims({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />{aspect !== "source" ? <div className="position-crop-box" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={(event) => begin(event, "move")}><span>{pxW}×{pxH} · {((pxW * pxH) / 1e6).toFixed(2)} MP</span>{(["nw", "ne", "sw", "se"] as const).map((corner) => <i key={corner} className={`crop-handle ${corner}`} onPointerDown={(event) => begin(event, corner)} />)}</div> : <div className="position-crop-full-label">Full source · {dims.width}×{dims.height}</div>}</div><small>{aspect === "source" ? "Inherit the complete source composition." : "Drag the window to reposition it; drag a corner to resize it."}</small></div>;
}

function clampAspectCrop(rect: CropRect, aspect: string, imageWidth: number, imageHeight: number): CropRect {
  const sourceAspect = imageWidth / Math.max(1, imageHeight);
  const target = aspectNumber(aspect, sourceAspect);
  let width = Math.max(0.02, Math.min(1, rect.width));
  let height = (width * sourceAspect) / target;
  if (height > 1) { height = 1; width = (height * target) / sourceAspect; }
  return { x: Math.max(0, Math.min(1 - width, rect.x)), y: Math.max(0, Math.min(1 - height, rect.y)), width, height };
}

function TrainerManualCropEditor({ imageUrl, filename, aspect, presets, presetId, policy, busy, onPresetChange, onCreate }: {
  imageUrl: string;
  filename: string;
  aspect: string;
  presets: ManualCropPreset[];
  presetId: string;
  policy: TrainingResolutionPolicy;
  busy: boolean;
  onPresetChange: (value: string) => void;
  onCreate: (crop: CropRect) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ width: 1, height: 1 });
  const [crop, setCrop] = useState<CropRect>({ x: 0, y: 0, width: 1, height: 1 });
  const [drag, setDrag] = useState<{ mode: DragMode; x: number; y: number; start: CropRect } | null>(null);
  const preset = presets.find((item) => item.id === presetId);

  useEffect(() => {
    if (!preset || dims.width <= 1 || dims.height <= 1) return;
    const width = Math.min(1, preset.width / dims.width);
    const height = Math.min(1, preset.height / dims.height);
    setCrop({ x: (1 - width) / 2, y: (1 - height) / 2, width, height });
  }, [filename, aspect, presetId, preset?.width, preset?.height, dims.width, dims.height]);

  function point(event: React.PointerEvent) {
    const bounds = ref.current!.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  }
  function begin(event: React.PointerEvent, mode: DragMode) {
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    const next = point(event); setDrag({ mode, x: next.x, y: next.y, start: crop });
  }
  function move(event: React.PointerEvent) {
    if (!drag) return;
    const next = point(event), dx = next.x - drag.x, dy = next.y - drag.y;
    if (drag.mode === "move") {
      setCrop({ ...drag.start, x: Math.max(0, Math.min(1 - drag.start.width, drag.start.x + dx)), y: Math.max(0, Math.min(1 - drag.start.height, drag.start.y + dy)) });
      return;
    }
    const sign = drag.mode?.includes("w") ? -1 : 1;
    const width = Math.max(0.02, drag.start.width + dx * sign);
    const right = drag.start.x + drag.start.width, bottom = drag.start.y + drag.start.height;
    let adjusted = clampAspectCrop({ x: drag.mode?.includes("w") ? right - width : drag.start.x, y: drag.start.y, width, height: drag.start.height }, aspect, dims.width, dims.height);
    if (drag.mode?.includes("n")) adjusted = clampAspectCrop({ ...adjusted, y: bottom - adjusted.height }, aspect, dims.width, dims.height);
    setCrop(adjusted); onPresetChange("custom");
  }

  const pxW = Math.max(1, Math.round(crop.width * dims.width));
  const pxH = Math.max(1, Math.round(crop.height * dims.height));
  const step = Math.max(8, policy.dimension_step || 16);
  const maxPixels = Math.max(0.01, policy.max_megapixels || 1) * 1_000_000;
  const cropPixels = Math.max(1, pxW * pxH);
  const scale = Math.min(1, Math.sqrt(maxPixels / cropPixels));
  const bucketW = Math.max(step, Math.floor(pxW * scale / step) * step);
  const bucketH = Math.max(step, Math.floor(pxH * scale / step) * step);
  const resize = bucketW !== pxW || bucketH !== pxH;
  const lowDetail = cropPixels < maxPixels * 0.5;

  return <div className="manual-editor-shell trainer-manual-editor">
    <div className="manual-preset-row">
      {presets.map((item) => { const optionLowDetail = item.megapixels < (policy.max_megapixels || 1) * 0.5; return <label key={item.id} className={`${presetId === item.id ? "selected" : ""} ${optionLowDetail ? "low-detail-option" : ""}`}><input type="radio" name="manual-crop-preset" checked={presetId === item.id} onChange={() => onPresetChange(item.id)} /><span><strong>{item.label}</strong><small>{item.width} × {item.height}{optionLowDetail ? " · low detail" : ""}</small></span></label>; })}
      <label className={presetId === "custom" ? "selected" : ""}><input type="radio" name="manual-crop-preset" checked={presetId === "custom"} onChange={() => onPresetChange("custom")} /><span><strong>Custom</strong><small>resize handles</small></span></label>
    </div>
    <div ref={ref} className="manual-crop-canvas" style={{ aspectRatio: `${dims.width}/${dims.height}` }} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
      <img src={imageUrl} alt={filename} draggable={false} onLoad={(event) => setDims({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
      <div className="manual-source-size">Prepared {dims.width}×{dims.height}</div>
      <div className="interactive-crop-box" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={(event) => begin(event, "move")}>
        <span className="crop-size-label">{pxW}×{pxH} · {((pxW * pxH) / 1e6).toFixed(2)} MP</span>
        {(["nw", "ne", "sw", "se"] as const).map((corner) => <span key={corner} className={`crop-handle ${corner}`} onPointerDown={(event) => begin(event, corner)} />)}
      </div>
    </div>
    <div className={`manual-crop-consequence ${lowDetail ? "low-detail" : resize ? "warn" : "good"}`}>{lowDetail ? `${pxW} × ${pxH} · low detail: below half of the ${(policy.max_megapixels || 1).toFixed(2)} MP trainer target` : resize ? `${pxW} × ${pxH} → trainer bucket ${bucketW} × ${bucketH} · resize required` : `${pxW} × ${pxH} → trainer native · no resize`}</div>
    <button className="primary" disabled={busy} onClick={() => onCreate(crop)}>Create {aspect} derivative</button>
  </div>;
}

function FaceProposalCard({ proposal, imageUrl, selected, targetMegapixels, onToggle }: { proposal: FaceCropProposal; imageUrl: string; selected: boolean; targetMegapixels: number; onToggle: () => void }) {
  const [x1, y1, x2, y2] = proposal.crop_box;
  const cropW = x2 - x1, cropH = y2 - y1, mp = cropW * cropH / 1e6, crop = proposal.normalized_crop;
  const lowDetail = mp < Math.max(0.01, targetMegapixels) * 0.5;
  return <button className={`prep-image-card face-proposal-card ${selected ? "selected" : ""} ${lowDetail ? "low-detail" : ""}`} onClick={onToggle}><div className="face-proposal-native" style={{ aspectRatio: `${proposal.source_width}/${proposal.source_height}` }}><img src={imageUrl} alt={proposal.filename} /><div className="face-crop-box" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} />{lowDetail && <div className="v6-card-flags"><span className="v6-quality-flag warning">LOW DETAIL</span></div>}</div><div className="prep-image-meta"><strong>{proposal.filename}</strong><span>Face {proposal.face_index + 1} · score {proposal.score}</span><span>{proposal.aspect_ratio} · {proposal.padding_percent}% padding</span><span className={lowDetail ? "status-suspect" : "status-good"}>Crop {cropW}×{cropH} · {mp.toFixed(2)} MP</span></div></button>;
}

function BucketPreview({ rows, onReview }: { rows: ResolutionAsset[]; onReview: (filename: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of rows) map.set(bucketKey(row), [...(map.get(bucketKey(row)) || []), row.filename]);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [rows]);
  const significant = rows.filter((row) => cropLoss(row) > 0.05);
  return <div className="bucket-preview stack"><div className="prep-section-heading"><div><div className="card-title">Expected bucket groups</div><p className="muted">Preview only; exact trainer assignments are confirmed after caching.</p></div><div className="bucket-summary"><strong>{groups.length}</strong><span>groups</span><strong>{rows.length}</strong><span>images</span></div></div><div className="bucket-group-grid">{groups.map(([key, names]) => <details className="bucket-group" key={key}><summary><strong>{key}</strong><span>{names.length} image{names.length === 1 ? "" : "s"}</span></summary><div className="bucket-file-list">{names.map((name) => <span key={name}>{name}</span>)}</div></details>)}</div>{significant.length > 0 && <div className="notice"><strong>{significant.length}</strong> image{significant.length === 1 ? "" : "s"} lose more than 5% to composition cropping.<div className="crop-review-actions">{significant.map((row) => <button className="secondary" key={row.filename} onClick={() => onReview(row.filename)}>Review {row.filename}</button>)}</div></div>}</div>;
}

export function ImagePrepWorkbenchPageV6() {
  const navigate = useNavigate();
  const { project, setProject, revision, setRevision, dataset, setDataset, modelFamily } = useSession();
  const importInput = useRef<HTMLInputElement | null>(null);
  const processingRef = useRef<HTMLElement | null>(null);
  const [prep, setPrep] = useState<ImagePrepState | null>(null);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [assetDrawerOpen, setAssetDrawerOpen] = useState(true);
  const [workingColumns, setWorkingColumns] = useState(2);
  const [tool, setTool] = useState<ProcessingTool>("global");
  const [toolSelection, setToolSelection] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [toastKind, setToastKind] = useState<"ok" | "warn" | "error">("ok");
  const [globalDraft, setGlobalDraft] = useState<ImageTransform>({});
  const [resolutionDraft, setResolutionDraft] = useState<TrainingResolutionPolicy>({ max_megapixels: 1, enable_bucket: true, bucket_no_upscale: true, dimension_step: 16 });
  const [manualAspect, setManualAspect] = useState("1:1");
  const [manualPresetId, setManualPresetId] = useState("trainer");
  const [manualPresets, setManualPresets] = useState<ManualCropPreset[]>([]);
  const [faceAspect, setFaceAspect] = useState("1:1");
  const [facePadding, setFacePadding] = useState(60);
  const [faceProposals, setFaceProposals] = useState<FaceCropProposal[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [editName, setEditName] = useState("");
  const [overrideDraft, setOverrideDraft] = useState<ImageTransform>({});
  const [previewVersion, setPreviewVersion] = useState(0);

  function notify(message: string, kind: "ok" | "warn" | "error" = "ok") {
    setToast(""); requestAnimationFrame(() => { setToastKind(kind); setToast(message); });
  }
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 5000); return () => window.clearTimeout(timer); }, [toast]);

  async function load() {
    if (!project || !revision) return;
    const state = await getImagePrepState(project.id, revision.id);
    setPrep(state); setGlobalDraft(state.global_transform); setResolutionDraft(state.training_resolution);
  }
  useEffect(() => { void load().catch((error) => notify(error instanceof Error ? error.message : "Unable to load Image Prep", "error")); }, [project?.id, revision?.id]);

  const assets = prep?.assets ?? revision?.assets ?? [];
  const sources = assets.filter((asset) => asset.asset_kind !== "derived");
  const workingSources = sources.filter((asset) => asset.included !== false);
  const derivatives = assets.filter((asset) => asset.asset_kind === "derived" && asset.included !== false);
  const included = [...workingSources, ...derivatives];
  const faceDerived = derivatives.filter((asset) => asset.origin === "face");
  const manualDerived = derivatives.filter((asset) => asset.origin === "manual");
  const rows = prep?.resolution_assets ?? [];
  const rowByFilename = new Map(rows.map((row) => [row.filename, row]));
  const visibleSources = sources.filter((asset) => assetFilter === "all" ? true : assetFilter === "included" ? asset.included !== false : asset.included === false);
  const sourceOverrides = workingSources.filter((asset) => Object.keys(asset.transform_override || {}).length > 0);
  const derivedOverrides = derivatives.filter((asset) => transformSummary(asset.transform_override || {}, derivativeBaseTransform(asset)).length > 0);
  const tonalDirty = !sameJson(tonalTransform(globalDraft), tonalTransform(prep?.global_transform || {}));
  const resolutionDirty = !sameJson(resolutionDraft, prep?.training_resolution);
  const editAsset = included.find((asset) => asset.filename === editName);
  const editBase = editAsset ? inheritedTransform(globalDraft, editAsset) : DEFAULT_GLOBAL;
  const overrideDirty = !sameJson(overrideDraft, editAsset?.transform_override ?? {});
  const manualAsset = workingSources.find((asset) => toolSelection.has(asset.filename)) ?? workingSources[0];
  const preparedPreview = (filename: string) => `${preparedAssetPreviewUrl(project!.id, revision!.id, filename)}?v=${previewVersion}`;
  const globalRecipeActive = transformSummary(tonalTransform(prep?.global_transform || {}), tonalTransform(DEFAULT_GLOBAL)).length > 0;
  const legacyGlobalCrop = legacyCompositionActive(prep?.global_transform);

  async function refresh() {
    if (!project || !revision) return null;
    const nextRevision = await getProjectRevision(project.id, revision.id);
    setRevision(nextRevision);
    const state = await getImagePrepState(project.id, revision.id);
    setPrep(state); setGlobalDraft(state.global_transform); setResolutionDraft(state.training_resolution);
    setDataset(await inspectDataset(nextRevision.files_path));
    setPreviewVersion((value) => value + 1);
    return state;
  }

  function activateTool(next: ProcessingTool) {
    setTool(next); setFaceProposals([]); setAccepted(new Set());
    if (next === "global") setToolSelection(new Set(workingSources.map((asset) => asset.filename)));
    if (next === "faces") setToolSelection(new Set(workingSources.map((asset) => asset.filename)));
    if (next === "manual") {
      const first = workingSources[0]?.filename || ""; setToolSelection(first ? new Set([first]) : new Set()); setManualPresetId("trainer");
    }
    if (next === "review") {
      const first = included[0]?.filename || ""; setToolSelection(first ? new Set([first]) : new Set());
      if (first) openReview(first);
    }
  }

  useEffect(() => {
    if (tool === "global") setToolSelection(new Set(workingSources.map((asset) => asset.filename)));
    if (tool === "manual" && (!manualAsset || !workingSources.some((asset) => toolSelection.has(asset.filename)))) {
      const first = workingSources[0]?.filename; if (first) setToolSelection(new Set([first]));
    }
  }, [workingSources.map((asset) => asset.filename).join("|"), tool]);

  useEffect(() => {
    if (!project || !revision || tool !== "manual" || !manualAsset) { setManualPresets([]); return; }
    let cancelled = false;
    getManualCropPresets(project.id, revision.id, manualAsset.filename, manualAspect)
      .then((result) => { if (!cancelled) { setManualPresets(result.presets); setManualPresetId((current) => result.presets.some((item) => item.id === current) || current === "custom" ? current : (result.presets[0]?.id || "custom")); } })
      .catch((error) => { if (!cancelled) notify(error instanceof Error ? error.message : "Unable to calculate trainer crop presets", "error"); });
    return () => { cancelled = true; };
  }, [project?.id, revision?.id, tool, manualAsset?.filename, manualAspect, resolutionDraft.max_megapixels, resolutionDraft.dimension_step, resolutionDraft.bucket_no_upscale]);

  async function toggleSourceInclusion(asset: ProjectAsset) {
    if (!project || !revision || busy) return;
    setBusy(true);
    try {
      await setImageInclusion(project.id, revision.id, [asset.filename], asset.included === false);
      await refresh();
      notify(`${asset.filename} ${asset.included === false ? "added to" : "removed from"} the working source pool.`);
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to change inclusion", "error"); }
    finally { setBusy(false); }
  }
  async function setAllSources(value: boolean) {
    if (!project || !revision || busy) return;
    setBusy(true);
    try { await setImageInclusion(project.id, revision.id, sources.map((asset) => asset.filename), value); await refresh(); notify(value ? "All first-class sources selected." : "All first-class sources excluded."); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to change inclusion", "error"); }
    finally { setBusy(false); }
  }
  async function importImages(files: File[]) {
    if (!project || !revision || !files.length) return;
    setBusy(true);
    try {
      const result = await importProjectImages(project.id, revision.id, files);
      setProject(result.project); setRevision(result.revision); setPrep(result.state); setGlobalDraft(result.state.global_transform); setResolutionDraft(result.state.training_resolution);
      setDataset(await inspectDataset(result.revision.files_path)); setPreviewVersion((value) => value + 1);
      notify(`${result.import.image_count} image${result.import.image_count === 1 ? "" : "s"} imported as ${result.import.id} and selected.`);
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to import images", "error"); }
    finally { setBusy(false); if (importInput.current) importInput.current.value = ""; }
  }

  async function saveGlobal() {
    if (!project || !revision || !tonalDirty) return;
    setBusy(true);
    try {
      const state = await setGlobalImageTransform(project.id, revision.id, tonalTransform(globalDraft));
      setPrep(state); setGlobalDraft(state.global_transform); setPreviewVersion((value) => value + 1); notify("Global image preparation saved for all first-class sources.");
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to save global preparation", "error"); }
    finally { setBusy(false); }
  }
  async function clearLegacyGlobalCrop() {
    if (!project || !revision) return;
    setBusy(true);
    try {
      const state = await setGlobalImageTransform(project.id, revision.id, { aspect_ratio: "source", crop_mode: "fit", crop_x: 0.5, crop_y: 0.5, crop_scale: 1 });
      setPrep(state); setGlobalDraft(state.global_transform); setPreviewVersion((value) => value + 1); notify("Legacy global composition crop cleared. Composition is now source-native unless overridden per image.");
    } finally { setBusy(false); }
  }
  async function saveResolution() {
    if (!project || !revision || !resolutionDirty) return;
    const before = bucketCount(rows); setBusy(true);
    try {
      const state = await setTrainingResolution(project.id, revision.id, resolutionDraft); setPrep(state); setResolutionDraft(state.training_resolution);
      const after = bucketCount(state.resolution_assets); notify(after !== before ? `Trainer policy saved · expected buckets ${before} → ${after}.` : "Trainer policy saved.", after !== before ? "warn" : "ok");
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to save trainer policy", "error"); }
    finally { setBusy(false); }
  }

  function toggleToolAsset(asset: ProjectAsset) {
    if (tool === "global") return;
    if ((tool === "faces" || tool === "manual") && asset.asset_kind === "derived") return;
    if (tool === "faces") {
      setToolSelection((current) => { const next = new Set(current); next.has(asset.filename) ? next.delete(asset.filename) : next.add(asset.filename); return next; });
      return;
    }
    setToolSelection(new Set([asset.filename]));
    if (tool === "manual") setManualPresetId("trainer");
    if (tool === "review") openReview(asset.filename);
  }

  async function detectFaces() {
    if (!project || !revision) return;
    const names = [...toolSelection].filter((name) => workingSources.some((asset) => asset.filename === name));
    if (!names.length) { notify("Select at least one source image for face detection.", "warn"); return; }
    setBusy(true);
    try {
      const result = await proposeFaceCrops(project.id, revision.id, names, faceAspect, facePadding); setFaceProposals(result.proposals); setAccepted(new Set(result.proposals.map((proposal) => proposal.id))); notify(`${result.proposals.length} face proposal(s) ready.`);
    } catch (error) { notify(error instanceof Error ? error.message : "Face detection failed", "error"); }
    finally { setBusy(false); }
  }
  async function addFaces() {
    if (!project || !revision) return;
    const chosen = faceProposals.filter((proposal) => accepted.has(proposal.id)); if (!chosen.length) return;
    setBusy(true);
    try { const result = await acceptFaceCrops(project.id, revision.id, chosen); setFaceProposals([]); setAccepted(new Set()); await refresh(); notify(`${result.assets.length} face derivative(s) added to Working Assets.`); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to add face derivatives", "error"); }
    finally { setBusy(false); }
  }
  async function addManual(crop: CropRect) {
    if (!project || !revision || !manualAsset) return;
    setBusy(true);
    try { await createManualCrop(project.id, revision.id, manualAsset.filename, manualAspect, crop); await refresh(); notify(`Manual ${manualAspect} derivative created from ${manualAsset.filename}.`); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to create derivative", "error"); }
    finally { setBusy(false); }
  }
  async function removeDerivative(asset: ProjectAsset) {
    if (!project || !revision || asset.asset_kind !== "derived") return;
    if (!window.confirm(`Remove project derivative ${asset.filename}?\n\nThe first-class source image is unaffected.`)) return;
    setBusy(true);
    try { await deleteDerivativeAsset(project.id, revision.id, asset.filename); if (editName === asset.filename) { setEditName(""); setOverrideDraft({}); } await refresh(); notify(`${asset.filename} removed.`); }
    catch (error) { notify(error instanceof Error ? error.message : "Unable to remove derivative", "error"); }
    finally { setBusy(false); }
  }

  function openReview(filename: string) {
    const asset = included.find((candidate) => candidate.filename === filename); if (!asset) return;
    setEditName(filename); setOverrideDraft(asset.transform_override || {}); setToolSelection(new Set([filename]));
  }
  async function saveOverride() {
    if (!project || !revision || !editAsset || !overrideDirty) return;
    const before = bucketCount(rows); setBusy(true);
    try {
      const state = await setAssetImageTransform(project.id, revision.id, editAsset.filename, overrideDraft); setPrep(state); await refresh(); const after = bucketCount(state.resolution_assets);
      notify(after !== before ? `Bucket layout changed ${before} → ${after} after ${editAsset.filename}.` : `${editAsset.filename} exception saved.`, after !== before ? "warn" : "ok");
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to save image exception", "error"); }
    finally { setBusy(false); }
  }
  async function resetOverride() {
    if (!project || !revision || !editAsset) return;
    const reset = editAsset.baked_transform ? derivativeBaseTransform(editAsset) : {};
    setBusy(true);
    try { await setAssetImageTransform(project.id, revision.id, editAsset.filename, reset); setOverrideDraft(reset); await refresh(); notify("Per-image exception reset."); }
    finally { setBusy(false); }
  }
  function reviewFromSummary(filename: string) {
    activateTool("review"); requestAnimationFrame(() => { openReview(filename); processingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); });
  }

  if (!project || !revision || !dataset) return <section className="panel"><h1>Image Prep</h1><p>Open a project first.</p></section>;

  const groups = [...new Set(rows.map(bucketKey))];
  const down = rows.filter((row) => row.direction === "downscale").length;
  const preserved = rows.filter((row) => row.direction === "native").length;
  const low = rows.filter((row) => row.low_detail).length;
  const cropReview = rows.filter((row) => cropLoss(row) > 0.05).length;
  const missing = included.filter((asset) => !asset.caption.trim()).length;
  const assetVersion = `${revision.id}:${included.map((asset) => asset.id || asset.filename).join(",")}`;

  return <div className="stack image-prep-page image-prep-v6">
    {toast && <div className={`prep-toast ${toastKind}`}>{toast}</div>}
    <header className="page-header v6-page-header"><div><p className="eyebrow">{project.name} · {revision.name}</p><h1>Image Prep</h1><p className="muted">Choose the first-class source pool, set the trainer policy, then process only what needs processing.</p></div><div className="prep-counts provenance-counts"><span><strong>{sources.length}</strong> sources</span><span className="status-good"><strong>{workingSources.length}</strong> selected</span><span><strong>{derivatives.length}</strong> derivatives</span><span><strong>{groups.length}</strong> buckets</span></div></header>

    <section className="panel stack v6-source-pool">
      <div className="prep-section-heading"><div><p className="eyebrow">Asset pool</p><div className="card-title">Base Image Assets</div><p className="muted">{sources.length} first-class source assets across {project.imports.length} import event{project.imports.length === 1 ? "" : "s"}. A checked source belongs to this revision's working pool.</p></div><div className="actions"><input ref={importInput} className="v6-hidden-input" type="file" accept="image/*,.jxl" multiple onChange={(event) => void importImages(Array.from(event.target.files || []))} /><button className="secondary" disabled={busy} onClick={() => importInput.current?.click()}><i className="ti ti-photo-plus" /> Import Image(s)</button><button className="secondary" disabled={busy} onClick={() => void setAllSources(true)}>Include all</button><button className="secondary" disabled={busy} onClick={() => void setAllSources(false)}>Exclude all</button><button className="icon-button v6-drawer-toggle" title={assetDrawerOpen ? "Collapse source assets" : "Expand source assets"} onClick={() => setAssetDrawerOpen((value) => !value)}><i className={`ti ${assetDrawerOpen ? "ti-square-chevron-up" : "ti-square-chevron-down"}`} /></button></div></div>
      <div className="v6-source-summary"><span><strong>{sources.length}</strong> First-Class Source Assets</span><span className="status-good"><strong>{workingSources.length}</strong> Selected</span><span><strong>{sources.length - workingSources.length}</strong> Excluded</span><span><strong>{project.imports.length}</strong> Import event{project.imports.length === 1 ? "" : "s"}</span></div>
      {assetDrawerOpen && <><div className="segmented v6-source-filter"><button className={assetFilter === "all" ? "selected" : ""} onClick={() => setAssetFilter("all")}>All {sources.length}</button><button className={assetFilter === "included" ? "selected" : ""} onClick={() => setAssetFilter("included")}>Selected {workingSources.length}</button><button className={assetFilter === "excluded" ? "selected" : ""} onClick={() => setAssetFilter("excluded")}>Excluded {sources.length - workingSources.length}</button></div><div className="v6-source-grid">{visibleSources.map((asset) => { const image = dataset.images.find((item) => item.filename === asset.filename); const selected = asset.included !== false; const row = rowByFilename.get(asset.filename); const lowDetail = Boolean(row?.low_detail); return <article className={`v6-source-card ${selected ? "selected" : "excluded"} ${lowDetail ? "low-detail" : ""}`} key={asset.filename}><div className="v6-source-image"><img src={image?.image_url || preparedPreview(asset.filename)} alt={asset.filename} /><button className={`v6-inclusion-check ${selected ? "checked" : ""}`} disabled={busy} title={selected ? "Exclude source" : "Include source"} onClick={() => void toggleSourceInclusion(asset)}>{selected ? "✓" : ""}</button>{asset.origin === "supplemental_import" && <span className="v6-import-badge">Imported later</span>}{lowDetail && <div className="v6-card-flags"><span className="v6-quality-flag warning">LOW DETAIL</span></div>}</div><div className="prep-image-meta"><strong title={asset.filename}>{asset.filename}</strong><span>{selected ? "In working source pool" : "Excluded from training pool"}</span>{row && <span className={lowDetail ? "v6-low-detail-text" : ""}>{row.file_width}×{row.file_height} → {row.bucket_width}×{row.bucket_height}</span>}</div></article>; })}</div></>}
    </section>

    <section className="panel stack training-resolution-panel v6-trainer-policy">
      <div className="prep-section-heading"><div><p className="eyebrow">Trainer policy</p><div className="card-title">Maximum Training Resolution</div><p className="muted">Set this before manual cropping so crop presets can target trainer-native bucket dimensions.</p></div><span className="badge">{modelFamily === "krea2" ? "Krea 2" : "Klein"}</span></div>
      <div className="v6-policy-row"><div className="segmented">{MP_PRESETS.map((mp) => <button key={mp} className={resolutionDraft.max_megapixels === mp ? "selected" : ""} onClick={() => setResolutionDraft({ ...resolutionDraft, max_megapixels: mp })}>{mp} MP</button>)}</div><label>Custom maximum MP<input type="number" min=".05" max="8" step=".05" value={resolutionDraft.max_megapixels} onChange={(event) => setResolutionDraft({ ...resolutionDraft, max_megapixels: Number(event.target.value) })} /></label><label className="inline-check"><input type="checkbox" checked={resolutionDraft.enable_bucket} onChange={(event) => setResolutionDraft({ ...resolutionDraft, enable_bucket: event.target.checked })} /> Aspect-ratio bucketing</label><label className="inline-check"><input type="checkbox" checked={resolutionDraft.bucket_no_upscale} onChange={(event) => setResolutionDraft({ ...resolutionDraft, bucket_no_upscale: event.target.checked })} /> Never upscale</label><button className="primary" disabled={busy || !resolutionDirty} onClick={() => void saveResolution()}>{resolutionDirty ? "Save Trainer Policy" : "Trainer Policy Saved"}</button></div>
      <div className="v6-policy-footer"><span>{rows.length} current training images · {groups.length} expected buckets · {preserved} native · {down} downscaled{low ? ` · ${low} low detail` : ""}</span><button className="secondary" disabled={!included.length} onClick={() => navigate("/captions")}>Skip Image Processing → Continue to Captions</button></div>
    </section>

    <section ref={processingRef} className="panel stack v6-processing-section">
      <div className="prep-section-heading"><div><p className="eyebrow">Image Processing</p><div className="card-title">Process the Working Asset Set</div><p className="muted">The tool determines which assets are eligible and how selection behaves. Derivatives live only in the Working Assets viewer.</p></div><div className="v6-live-strip"><span>{workingSources.length} sources</span><span>{derivatives.length} derivatives</span><span>{included.length} training images</span><span>{groups.length} expected buckets</span>{low > 0 && <span className="status-suspect">{low} low detail</span>}</div></div>
      <div className="v6-processing-layout">
        <div className="v6-processing-tools">
          <div className="v6-tool-tabs"><button className={tool === "global" ? "selected" : ""} onClick={() => activateTool("global")}>Global Preparation</button><button className={tool === "faces" ? "selected" : ""} onClick={() => activateTool("faces")}>Face Derivatives</button><button className={tool === "manual" ? "selected" : ""} onClick={() => activateTool("manual")}>Manual Cropping</button><button className={tool === "review" ? "selected" : ""} onClick={() => activateTool("review")}>Per-image Review</button></div>

          {tool === "global" && <div className="stack v6-tool-panel"><div><p className="eyebrow">Global Image Preparation</p><div className="card-title">All {workingSources.length} selected sources</div><p className="muted">Global preparation is tonal only. Selection is locked to every included first-class source; derivatives are never changed by this control.</p></div>{legacyGlobalCrop && <div className="notice warning"><strong>Legacy global composition is still active.</strong> This project predates the tonal-only Global Preparation flow, so its saved global crop is still honored for reproducibility.<div className="actions"><button className="secondary" disabled={busy} onClick={() => void clearLegacyGlobalCrop()}>Clear legacy global crop</button></div></div>}<div className="tuning-grid v6-global-tuning"><SliderField label="Exposure" min={-2} max={2} step={0.1} value={globalDraft.exposure ?? 0} onChange={(value) => setGlobalDraft({ ...globalDraft, exposure: value })} /><SliderField label="Brightness" min={-0.5} max={0.5} step={0.05} value={globalDraft.brightness ?? 0} onChange={(value) => setGlobalDraft({ ...globalDraft, brightness: value })} /><SliderField label="Contrast" min={-0.5} max={0.5} step={0.05} value={globalDraft.contrast ?? 0} onChange={(value) => setGlobalDraft({ ...globalDraft, contrast: value })} /><SliderField label="Gamma" min={0.5} max={1.5} step={0.05} value={globalDraft.gamma ?? 1} onChange={(value) => setGlobalDraft({ ...globalDraft, gamma: value })} /></div><button className="primary" disabled={busy || !tonalDirty} onClick={() => void saveGlobal()}>{tonalDirty ? "Save Global Preparation" : "Global Preparation Saved"}</button></div>}

          {tool === "faces" && <div className="stack v6-tool-panel"><div><p className="eyebrow">Automatic Face Derivatives</p><div className="card-title">{toolSelection.size} source image{toolSelection.size === 1 ? "" : "s"} selected</div><p className="muted">All sources are selected when this tool opens. Change the selection in Working Assets before detecting if you only want a subset.</p></div><div className="v6-face-source-selection"><button className="micro-action" disabled={busy || toolSelection.size === workingSources.length} onClick={() => setToolSelection(new Set(workingSources.map((asset) => asset.filename)))}>Select all sources</button><button className="micro-action" disabled={busy || toolSelection.size === 0} onClick={() => setToolSelection(new Set())}>Deselect all</button><span className="selection-count">{toolSelection.size} / {workingSources.length} selected</span></div><div className="form-row"><label>Derivative aspect<select value={faceAspect} onChange={(event) => setFaceAspect(event.target.value)}>{DERIVATIVE_ASPECTS.map((aspect) => <option key={aspect}>{aspect}</option>)}</select></label><label>Face padding %<input type="number" min="0" max="400" step="10" value={facePadding} onChange={(event) => setFacePadding(Number(event.target.value))} /></label><button className="secondary" disabled={busy || !toolSelection.size} onClick={() => void detectFaces()}>Detect faces & propose crops</button></div>{faceProposals.length > 0 && <><div className="v6-face-proposals">{faceProposals.map((proposal) => <FaceProposalCard key={proposal.id} proposal={proposal} imageUrl={proposal.preview_url || preparedPreview(proposal.filename)} selected={accepted.has(proposal.id)} targetMegapixels={resolutionDraft.max_megapixels} onToggle={() => setAccepted((current) => { const next = new Set(current); next.has(proposal.id) ? next.delete(proposal.id) : next.add(proposal.id); return next; })} />)}</div><div className="selection-bar face-selection-bar"><div className="actions"><button className="secondary" onClick={() => setAccepted(new Set(faceProposals.map((proposal) => proposal.id)))}>Select all proposals</button><button className="secondary" onClick={() => setAccepted(new Set())}>Deselect all</button></div><span><strong>{accepted.size}</strong> of {faceProposals.length}</span><button className="primary" disabled={!accepted.size || busy} onClick={() => void addFaces()}>Add selected derivatives</button></div></>}</div>}

          {tool === "manual" && <div className="stack v6-tool-panel"><div><p className="eyebrow">Manual Cropping</p><div className="card-title">{manualAsset?.filename || "Select a source"}</div><p className="muted">Select one first-class source in Working Assets. Trainer-aware presets avoid arbitrary crop sizes and unnecessary resize buckets.</p></div><label>Derivative aspect<select value={manualAspect} onChange={(event) => { setManualAspect(event.target.value); setManualPresetId("trainer"); }}>{DERIVATIVE_ASPECTS.map((aspect) => <option key={aspect}>{aspect}</option>)}</select></label>{manualAsset && <TrainerManualCropEditor imageUrl={preparedPreview(manualAsset.filename)} filename={manualAsset.filename} aspect={manualAspect} presets={manualPresets} presetId={manualPresetId} policy={resolutionDraft} busy={busy} onPresetChange={setManualPresetId} onCreate={(crop) => void addManual(crop)} />}</div>}

          {tool === "review" && <div className="stack v6-tool-panel"><div><p className="eyebrow">Per-image Exceptions & Crop Review</p><div className="card-title">{editAsset?.filename || "Select an image"}</div><p className="muted">Single-image review. Sources inherit Global Preparation; derivatives start from their baked prepared pixels.</p></div>{editAsset && (() => { const image = dataset.images.find((candidate) => candidate.filename === editAsset.filename); if (!image) return <div className="notice warning">The selected image file is not available in the current dataset.</div>; return <><PositionCropEditor imageUrl={image.image_url} filename={editAsset.filename} aspect={overrideDraft.aspect_ratio ?? editBase.aspect_ratio ?? "source"} scale={overrideDraft.crop_scale ?? editBase.crop_scale ?? 1} cropX={overrideDraft.crop_x ?? editBase.crop_x ?? 0.5} cropY={overrideDraft.crop_y ?? editBase.crop_y ?? 0.5} filter={previewFilter({ ...editBase, ...overrideDraft })} onChange={(next) => setOverrideDraft({ ...overrideDraft, crop_x: next.x, crop_y: next.y, crop_scale: next.scale, crop_mode: "fill" })} /><label>Composition<select value={overrideDraft.aspect_ratio ?? ""} onChange={(event) => setOverrideDraft({ ...overrideDraft, aspect_ratio: event.target.value || undefined, crop_x: 0.5, crop_y: 0.5, crop_scale: 1, crop_mode: event.target.value && event.target.value !== "source" ? "fill" : undefined })}><option value="">Inherit Source</option>{ASPECTS.map((aspect) => <option key={aspect} value={aspect}>{aspect === "source" ? "Full source / no crop" : aspect}</option>)}</select></label><div className="tuning-grid"><SliderField label="Exposure" min={-2} max={2} step={0.1} value={overrideDraft.exposure ?? editBase.exposure ?? 0} onChange={(value) => setOverrideDraft({ ...overrideDraft, exposure: value })} /><SliderField label="Brightness" min={-0.5} max={0.5} step={0.05} value={overrideDraft.brightness ?? editBase.brightness ?? 0} onChange={(value) => setOverrideDraft({ ...overrideDraft, brightness: value })} /><SliderField label="Contrast" min={-0.5} max={0.5} step={0.05} value={overrideDraft.contrast ?? editBase.contrast ?? 0} onChange={(value) => setOverrideDraft({ ...overrideDraft, contrast: value })} /><SliderField label="Gamma" min={0.5} max={1.5} step={0.05} value={overrideDraft.gamma ?? editBase.gamma ?? 1} onChange={(value) => setOverrideDraft({ ...overrideDraft, gamma: value })} /></div><div className="actions">{editAsset.asset_kind === "derived" && <button className="danger secondary" disabled={busy} onClick={() => void removeDerivative(editAsset)}>Remove derivative</button>}<button className="secondary" disabled={busy} onClick={() => void resetOverride()}>Reset</button><button className="primary" disabled={busy || !overrideDirty} onClick={() => void saveOverride()}>{overrideDirty ? "Save Image Exception" : "Image Exception Saved"}</button></div></>; })()}</div>}
        </div>

        <aside className="v6-working-assets">
          <div className="v6-working-heading"><div><p className="eyebrow">Working Assets</p><strong>{included.length} training images</strong><small>{tool === "global" ? "All sources selected · derivatives unaffected" : tool === "faces" ? "Multi-select sources" : "Single-select"}</small></div><div className="v6-density-control"><button title="Larger previews" disabled={workingColumns <= 1} onClick={() => setWorkingColumns((value) => Math.max(1, value - 1))}>−</button><span>{workingColumns} / row</span><button title="Smaller previews" disabled={workingColumns >= 4} onClick={() => setWorkingColumns((value) => Math.min(4, value + 1))}>+</button></div></div>
          <div className="v6-working-scroll"><div className="v6-working-grid" style={{ "--working-columns": workingColumns } as React.CSSProperties}>{included.map((asset) => { const selected = toolSelection.has(asset.filename); const sourceOnlyTool = tool === "global" || tool === "faces" || tool === "manual"; const unavailable = sourceOnlyTool && asset.asset_kind === "derived"; const raw = dataset.images.find((image) => image.filename === asset.filename)?.image_url; const liveGlobal = tool === "global" && asset.asset_kind !== "derived" && tonalDirty; const imageUrl = liveGlobal && raw ? raw : preparedPreview(asset.filename); const badge = asset.asset_kind === "derived" ? (asset.origin === "face" ? "FACE" : "MANUAL") : "SOURCE"; const row = rowByFilename.get(asset.filename); const lowDetail = Boolean(row?.low_detail); const cropped = hasCompositionCrop(asset, row); return <button className={`v6-working-card ${selected ? "selected" : ""} ${unavailable ? "unavailable" : ""} ${lowDetail ? "low-detail" : ""}`} key={asset.filename} disabled={tool === "global" || unavailable} onClick={() => toggleToolAsset(asset)}><div className="v6-working-image"><img src={imageUrl} alt={asset.filename} style={liveGlobal ? { filter: previewFilter(globalDraft) } : undefined} /><span className={`v6-kind-badge ${asset.asset_kind === "derived" ? "derived" : "source"}`}>{badge}</span>{selected && <span className="v6-tool-check">✓</span>}{unavailable && <span className="v6-tool-disabled">Not affected</span>}{(cropped || lowDetail) && <div className="v6-card-flags">{cropped && <span className="v6-crop-flag" title="Composition crop active">↗↙</span>}{lowDetail && <span className="v6-quality-flag warning">LOW DETAIL</span>}</div>}</div><div className="prep-image-meta"><strong title={asset.filename}>{asset.filename}</strong>{asset.asset_kind === "derived" && <span>Parent: {asset.parent_filename || "source"}</span>}{row && <span className={lowDetail ? "v6-low-detail-text" : ""}>{row.file_width}×{row.file_height} → {row.bucket_width}×{row.bucket_height}</span>}</div></button>; })}</div></div>
        </aside>
      </div>
    </section>

    <section className="panel stack dataset-final-summary clean-summary v6-dataset-review"><div className="prep-section-heading"><div><p className="eyebrow">Dataset Review</p><div className="card-title">Training Dataset Summary</div><p className="muted">The effective project state that will carry into captions and run preparation.</p></div><span className="badge">{project.id}</span></div><div className="summary-ledger"><div><span>Working set</span><strong>{included.length} images</strong><small>{workingSources.length} source · {derivatives.length} derived</small></div><div><span>Excluded sources</span><strong>{sources.length - workingSources.length}</strong><small>remain first-class project assets</small></div><div><span>Global preparation</span><strong>{globalRecipeActive ? "Active" : "Default"}</strong><small>{globalRecipeActive ? transformSummary(tonalTransform(prep?.global_transform || {}), tonalTransform(DEFAULT_GLOBAL)).join(" · ") : "No global tonal change"}</small></div><div><span>Source exceptions</span><strong>{sourceOverrides.length}</strong><small>per-image overrides</small></div><div><span>Derivatives</span><strong>{derivatives.length}</strong><small>{faceDerived.length} face · {manualDerived.length} manual</small></div><div><span>Adjusted derivatives</span><strong>{derivedOverrides.length}</strong><small>post-derivative exceptions</small></div><div><span>Training resolution</span><strong>{resolutionDraft.max_megapixels.toFixed(2)} MP max</strong><small>{down} downscale · {preserved} native</small></div><div><span>Expected buckets</span><strong>{groups.length}</strong><small>{groups.join(" · ") || "none"}</small></div><div><span>Crop review</span><strong>{cropReview}</strong><small>&gt;5% source area removed</small></div><div><span className={low ? "status-suspect" : ""}>Low detail</span><strong className={low ? "status-suspect" : ""}>{low}</strong><small className={low ? "status-suspect" : ""}>below half target budget</small></div><div><span>Need captions</span><strong>{missing}</strong><small>will surface next</small></div></div><BucketPreview rows={rows} onReview={reviewFromSummary} /></section>

    <section className="panel stack training-filename-panel v6-training-filenames"><TrainingFilenamePolicyEditor projectId={project.id} revisionId={revision.id} suggestedBasename={project.trigger_word || project.id} assetVersion={assetVersion} /></section>

    <section className="panel v6-continue-panel"><div><strong>Image Prep complete when you're happy with the working set.</strong><p className="muted">Captions will see exactly the {included.length} included source + derivative images above.</p></div><button className="primary" disabled={!included.length} onClick={() => navigate("/captions")}>Continue to Captions →</button></section>
  </div>;
}
