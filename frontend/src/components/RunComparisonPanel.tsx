import { useEffect, useMemo, useState } from "react";
import {
  getRun,
  getRunTelemetry,
  type DecisionImageState,
  type RunInfo,
  type TrainingMetric,
  type TrainingSample,
  type TrainingTelemetry,
} from "../api";

type Props = {
  projectId: string;
  runIds: [string, string];
  onClose: () => void;
};

type LoadedRun = {
  run: RunInfo;
  telemetry: TrainingTelemetry;
};

type PlotPoint = {
  x: number;
  y: number;
  epoch?: number;
  verdict?: string;
  recommended?: number | null;
  effective?: number | null;
};

type ChartMode = "overlay" | "split";

type AxisBounds = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

type AssetBinding = {
  canonical: string;
  key: string;
  previewUrl: string;
  trainingFilename: string;
};

const VIEW_W = 1000;
const VIEW_H = 270;
const PAD_X = 58;
const PAD_Y = 28;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function metricNumber(row: TrainingMetric, field: string) {
  const value = (row as unknown as Record<string, unknown>)[field];
  return finite(value) ? value : null;
}

function stateNumber(state: DecisionImageState | undefined, field: string) {
  if (!state) return null;
  const value = (state as unknown as Record<string, unknown>)[field];
  return finite(value) ? value : null;
}

function configSection(run: RunInfo, name: string) {
  return record(run.config?.[name]);
}

function configValue(run: RunInfo, section: string, field: string) {
  return configSection(run, section)[field];
}

function softwareValue(run: RunInfo, group: string, field: string) {
  const value = record(record(run.software)[group])[field];
  return typeof value === "string" && value ? value : "unknown";
}

function runMode(run: RunInfo) {
  const configured = run.config?.training_mode;
  if (typeof configured === "string" && configured) return configured;
  return run.telemetry_mode || "observation_only";
}

function prettyMode(value: string) {
  if (value === "loss_watch_intervention") return "Loss-watch intervention";
  if (value === "observation_only") return "Observation only";
  return value.replaceAll("_", " ");
}

function modelSignature(run: RunInfo) {
  const assets = Array.isArray(record(run.model_manifest).assets) ? record(run.model_manifest).assets as Array<Record<string, unknown>> : [];
  return assets
    .filter((asset) => asset.core !== false)
    .map((asset) => `${String(asset.key || asset.filename || "asset")}:${String(asset.sha256 || "")}`)
    .sort()
    .join("|");
}

function scheduleValue(run: RunInfo, field: string) {
  const schedule = record((run as unknown as Record<string, unknown>).schedule_manifest);
  const value = schedule[field];
  return typeof value === "string" && value ? value : "";
}

function stableValue(value: unknown): string {
  if (value === undefined) return "<unset>";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function flattenConfig(value: unknown, prefix = "", output: Record<string, string> = {}) {
  if (Array.isArray(value)) {
    output[prefix] = stableValue(value);
    return output;
  }
  if (!value || typeof value !== "object") {
    output[prefix] = stableValue(value);
    return output;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length && prefix) output[prefix] = "{}";
  for (const [key, child] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) flattenConfig(child, path, output);
    else output[path] = stableValue(child);
  }
  return output;
}

function configDifferences(a: RunInfo, b: RunInfo) {
  const left = flattenConfig(a.config);
  const right = flattenConfig(b.config);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .flatMap((path) => left[path] === right[path] ? [] : [{ path, a: left[path] ?? "<unset>", b: right[path] ?? "<unset>" }]);
}

function globalLossSeries(telemetry: TrainingTelemetry): PlotPoint[] {
  const contexts = telemetry.metrics.filter((row) => row.type === "step_context" && metricNumber(row, "global_step") !== null);
  const byEpochStep = new Map<string, TrainingMetric>();
  contexts.forEach((row) => {
    const epoch = metricNumber(row, "epoch") ?? row.epoch;
    const step = metricNumber(row, "step_in_epoch");
    if (step !== null) byEpochStep.set(`${epoch}:${step}`, row);
  });

  const losses = telemetry.metrics.filter((row) => row.type === "loss" && finite(row.loss_moving_average));
  return losses.map((row, index) => {
    const epoch = metricNumber(row, "epoch") ?? row.epoch;
    const step = metricNumber(row, "step_in_epoch");
    const context = step === null ? contexts[index] : byEpochStep.get(`${epoch}:${step}`) ?? contexts[index];
    const globalStep = context ? metricNumber(context, "global_step") : null;
    return { x: globalStep ?? index + 1, y: row.loss_moving_average as number, epoch };
  }).sort((a, b) => a.x - b.x);
}

function assetBindings(telemetry: TrainingTelemetry) {
  const result = new Map<string, AssetBinding>();
  for (const asset of telemetry.assets ?? []) {
    const canonical = asset.project_filename || asset.training_filename || asset.key;
    result.set(canonical, {
      canonical,
      key: asset.key,
      previewUrl: asset.preview_url,
      trainingFilename: asset.training_filename || asset.key,
    });
  }
  const decisionKeys = new Set<string>();
  for (const snapshot of telemetry.decision_history ?? []) Object.keys(snapshot.images || {}).forEach((key) => decisionKeys.add(key));
  for (const key of decisionKeys) {
    if (![...result.values()].some((binding) => binding.key === key)) {
      result.set(key, { canonical: key, key, previewUrl: "", trainingFilename: key });
    }
  }
  return result;
}

function decisionSeries(telemetry: TrainingTelemetry, key: string | undefined): PlotPoint[] {
  if (!key) return [];
  return (telemetry.decision_history ?? []).flatMap((snapshot) => {
    const state = snapshot.images?.[key];
    if (!state || !finite(state.mean_residual)) return [];
    return [{
      x: snapshot.epoch,
      y: state.mean_residual,
      epoch: snapshot.epoch,
      verdict: state.verdict,
      recommended: stateNumber(state, "recommended_multiplier"),
      effective: stateNumber(state, "multiplier"),
    }];
  });
}

function latestDecision(telemetry: TrainingTelemetry, key: string | undefined) {
  if (!key) return undefined;
  for (let index = telemetry.decision_history.length - 1; index >= 0; index -= 1) {
    const state = telemetry.decision_history[index]?.images?.[key];
    if (state) return { epoch: telemetry.decision_history[index].epoch, state };
  }
  return undefined;
}

function axisBounds(a: PlotPoint[], b: PlotPoint[]): AxisBounds {
  const points = [...a, ...b];
  if (!points.length) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
  let xMin = Math.min(...points.map((point) => point.x));
  let xMax = Math.max(...points.map((point) => point.x));
  let yMin = Math.min(...points.map((point) => point.y));
  let yMax = Math.max(...points.map((point) => point.y));
  if (xMin === xMax) { xMin -= 0.5; xMax += 0.5; }
  if (Math.abs(yMax - yMin) < 1e-12) {
    const pad = Math.abs(yMax || 1) * 0.08;
    yMin -= pad;
    yMax += pad;
  } else {
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad;
    yMax += pad;
  }
  return { xMin, xMax, yMin, yMax };
}

function xFor(value: number, bounds: AxisBounds) {
  return PAD_X + ((value - bounds.xMin) / (bounds.xMax - bounds.xMin)) * (VIEW_W - PAD_X * 2);
}

function yFor(value: number, bounds: AxisBounds) {
  return PAD_Y + ((bounds.yMax - value) / (bounds.yMax - bounds.yMin)) * (VIEW_H - PAD_Y * 2);
}

function pathFor(points: PlotPoint[], bounds: AxisBounds) {
  return points.map((point, index) => `${index ? "L" : "M"}${xFor(point.x, bounds).toFixed(2)},${yFor(point.y, bounds).toFixed(2)}`).join(" ");
}

function formatNumber(value: number, digits = 4) {
  if (Math.abs(value) > 0 && Math.abs(value) < 0.001) return value.toExponential(2);
  return value.toFixed(digits);
}

function axisTicks(min: number, max: number, count = 5) {
  return Array.from({ length: count }, (_, index) => min + (index / (count - 1)) * (max - min));
}

function SharedAxesSvg({
  a,
  b,
  bounds,
  labelA,
  labelB,
  ariaLabel,
  showPoints = false,
}: {
  a: PlotPoint[];
  b: PlotPoint[];
  bounds: AxisBounds;
  labelA: string;
  labelB: string;
  ariaLabel: string;
  showPoints?: boolean;
}) {
  const xTicks = axisTicks(bounds.xMin, bounds.xMax);
  const yTicks = axisTicks(bounds.yMin, bounds.yMax);
  return <svg className="run-compare-chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={ariaLabel}>
    {yTicks.map((tick, index) => {
      const y = yFor(tick, bounds);
      return <g key={`y-${index}`}>
        <line className="run-compare-grid" x1={PAD_X} x2={VIEW_W - PAD_X} y1={y} y2={y} />
        <text className="run-compare-axis-label" x={4} y={y + 4}>{formatNumber(tick)}</text>
      </g>;
    })}
    {xTicks.map((tick, index) => {
      const x = xFor(tick, bounds);
      return <g key={`x-${index}`}>
        <line className="run-compare-x-tick" x1={x} x2={x} y1={VIEW_H - PAD_Y} y2={VIEW_H - PAD_Y + 4} />
        <text className="run-compare-axis-label" textAnchor="middle" x={x} y={VIEW_H - 5}>{Math.round(tick)}</text>
      </g>;
    })}
    {bounds.yMin <= 0 && bounds.yMax >= 0 && <line className="run-compare-zero" x1={PAD_X} x2={VIEW_W - PAD_X} y1={yFor(0, bounds)} y2={yFor(0, bounds)} />}
    {a.length > 1 && <path className="run-compare-line run-a" d={pathFor(a, bounds)} />}
    {b.length > 1 && <path className="run-compare-line run-b" d={pathFor(b, bounds)} />}
    {showPoints && a.map((point, index) => <circle className="run-compare-point run-a" key={`a-${point.x}-${index}`} cx={xFor(point.x, bounds)} cy={yFor(point.y, bounds)} r={3.2}><title>{`${labelA} · epoch ${point.epoch ?? point.x} · residual ${formatNumber(point.y)} · ${point.verdict || "—"} · recommended ×${(point.recommended ?? 1).toFixed(2)} · effective ×${(point.effective ?? 1).toFixed(2)}`}</title></circle>)}
    {showPoints && b.map((point, index) => <circle className="run-compare-point run-b" key={`b-${point.x}-${index}`} cx={xFor(point.x, bounds)} cy={yFor(point.y, bounds)} r={3.2}><title>{`${labelB} · epoch ${point.epoch ?? point.x} · residual ${formatNumber(point.y)} · ${point.verdict || "—"} · recommended ×${(point.recommended ?? 1).toFixed(2)} · effective ×${(point.effective ?? 1).toFixed(2)}`}</title></circle>)}
  </svg>;
}

function ComparisonChart({
  a,
  b,
  labelA,
  labelB,
  mode,
  showPoints = false,
  emptyText,
}: {
  a: PlotPoint[];
  b: PlotPoint[];
  labelA: string;
  labelB: string;
  mode: ChartMode;
  showPoints?: boolean;
  emptyText: string;
}) {
  const bounds = axisBounds(a, b);
  if (!a.length && !b.length) return <div className="run-compare-empty">{emptyText}</div>;
  if (mode === "overlay") {
    return <div className="run-compare-chart-shell">
      <SharedAxesSvg a={a} b={b} bounds={bounds} labelA={labelA} labelB={labelB} ariaLabel={`${labelA} and ${labelB} comparison chart`} showPoints={showPoints} />
    </div>;
  }
  return <div className="run-compare-split-charts">
    <div className="run-compare-chart-shell"><div className="run-compare-split-label run-a">Run A · {labelA}</div><SharedAxesSvg a={a} b={[]} bounds={bounds} labelA={labelA} labelB={labelB} ariaLabel={`${labelA} comparison chart`} showPoints={showPoints} /></div>
    <div className="run-compare-chart-shell"><div className="run-compare-split-label run-b">Run B · {labelB}</div><SharedAxesSvg a={[]} b={b} bounds={bounds} labelA={labelA} labelB={labelB} ariaLabel={`${labelB} comparison chart`} showPoints={showPoints} /></div>
  </div>;
}

function compareStatus(a: string, b: string, unknown = "Unknown") {
  if (!a || !b || a === "unknown" || b === "unknown") return { label: unknown, className: "unknown" };
  return a === b ? { label: "Match", className: "match" } : { label: "Different", className: "different" };
}

function shortSha(value: string) {
  return !value || value === "unknown" ? "unknown" : value.slice(0, 12);
}

function sampleKey(sample: TrainingSample) {
  return `${sample.epoch ?? -1}:${sample.sample_index ?? -1}`;
}

function sampleLabel(sample: TrainingSample | undefined) {
  if (!sample) return "Missing";
  const probe = sample.sample_index === null ? sample.filename : `Probe ${sample.sample_index + 1}`;
  return `${probe}${sample.epoch === null ? "" : ` · epoch ${sample.epoch}`}`;
}

function lossWatchSummary(run: RunInfo) {
  const watch = configSection(run, "loss_watch");
  const parts = [
    `per-image LR ${watch.per_image_lr ? "ON" : "off"}`,
    `recaption ${watch.auto_recaption ? "ON" : "off"}`,
  ];
  return parts.join(" · ");
}

export function RunComparisonPanel({ projectId, runIds, onClose }: Props) {
  const [loaded, setLoaded] = useState<[LoadedRun, LoadedRun] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [globalMode, setGlobalMode] = useState<ChartMode>("overlay");
  const [imageMode, setImageMode] = useState<ChartMode>("overlay");
  const [selectedAsset, setSelectedAsset] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setLoaded(null);
    Promise.all(runIds.map(async (runId) => ({
      run: await getRun(projectId, runId),
      telemetry: await getRunTelemetry(projectId, runId),
    })))
      .then((rows) => { if (!cancelled) setLoaded(rows as [LoadedRun, LoadedRun]); })
      .catch((exc) => { if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, runIds[0], runIds[1]]);

  const comparison = useMemo(() => {
    if (!loaded) return null;
    const [a, b] = loaded;
    const bindingsA = assetBindings(a.telemetry);
    const bindingsB = assetBindings(b.telemetry);
    const assets = [...new Set([...bindingsA.keys(), ...bindingsB.keys()])].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const differences = configDifferences(a.run, b.run);
    const globalA = globalLossSeries(a.telemetry);
    const globalB = globalLossSeries(b.telemetry);
    const scheduleA = scheduleValue(a.run, "image_order_sha256");
    const scheduleB = scheduleValue(b.run, "image_order_sha256");
    const timestepA = scheduleValue(a.run, "image_timestep_schedule_sha256");
    const timestepB = scheduleValue(b.run, "image_timestep_schedule_sha256");
    const sampleMapA = new Map(a.telemetry.samples.map((sample) => [sampleKey(sample), sample]));
    const sampleMapB = new Map(b.telemetry.samples.map((sample) => [sampleKey(sample), sample]));
    const sampleKeys = [...new Set([...sampleMapA.keys(), ...sampleMapB.keys()])].sort((left, right) => {
      const [le, lp] = left.split(":").map(Number);
      const [re, rp] = right.split(":").map(Number);
      return le - re || lp - rp;
    });
    return { a, b, bindingsA, bindingsB, assets, differences, globalA, globalB, scheduleA, scheduleB, timestepA, timestepB, sampleMapA, sampleMapB, sampleKeys };
  }, [loaded]);

  useEffect(() => {
    if (!comparison?.assets.length) {
      setSelectedAsset("");
      return;
    }
    if (!selectedAsset || !comparison.assets.includes(selectedAsset)) setSelectedAsset(comparison.assets[0]);
  }, [comparison?.assets, selectedAsset]);

  if (loading) return <section className="panel run-comparison-panel"><div className="run-compare-empty">Loading both immutable runs and their telemetry…</div></section>;
  if (error || !comparison) return <section className="panel stack run-comparison-panel"><div className="training-section-heading"><div><p className="eyebrow">Run comparison</p><div className="card-title">Unable to compare runs</div></div><button className="secondary" type="button" onClick={onClose}>Close</button></div><div className="notice error">{error || "Comparison data is unavailable."}</div></section>;

  const { a, b } = comparison;
  const bindingA = comparison.bindingsA.get(selectedAsset);
  const bindingB = comparison.bindingsB.get(selectedAsset);
  const imageSeriesA = decisionSeries(a.telemetry, bindingA?.key);
  const imageSeriesB = decisionSeries(b.telemetry, bindingB?.key);
  const latestA = latestDecision(a.telemetry, bindingA?.key);
  const latestB = latestDecision(b.telemetry, bindingB?.key);
  const modelStatus = compareStatus(modelSignature(a.run), modelSignature(b.run));
  const upstreamStatus = compareStatus(softwareValue(a.run, "fizgig", "commit"), softwareValue(b.run, "fizgig", "commit"));
  const webStatus = compareStatus(softwareValue(a.run, "fizgig_web", "vcs_ref"), softwareValue(b.run, "fizgig_web", "vcs_ref"));
  const scheduleStatus = compareStatus(comparison.scheduleA, comparison.scheduleB, "Pending / unavailable");
  const timestepStatus = compareStatus(comparison.timestepA, comparison.timestepB, "Pending / unavailable");
  const datasetStatus = compareStatus(a.run.dataset_revision, b.run.dataset_revision);
  const seedA = stableValue(configValue(a.run, "training", "seed"));
  const seedB = stableValue(configValue(b.run, "training", "seed"));
  const seedStatus = compareStatus(seedA, seedB);

  return <section className="panel stack run-comparison-panel">
    <div className="training-section-heading run-compare-heading">
      <div>
        <p className="eyebrow">A/B analysis</p>
        <div className="card-title">Run Comparison</div>
        <p className="muted">Both loss views use one shared x/y domain calculated from the union of Run A and Run B. Split mode keeps those exact same axes so visual magnitude remains directly comparable.</p>
      </div>
      <button className="secondary" type="button" onClick={onClose}>Close comparison</button>
    </div>

    <div className="run-compare-run-cards">
      <div className="run-compare-run-card run-a"><span>Run A</span><strong>{a.run.id} · {a.run.name}</strong><small>{prettyMode(runMode(a.run))} · {lossWatchSummary(a.run)}</small></div>
      <div className="run-compare-run-card run-b"><span>Run B</span><strong>{b.run.id} · {b.run.name}</strong><small>{prettyMode(runMode(b.run))} · {lossWatchSummary(b.run)}</small></div>
    </div>

    <div className="run-compare-subsection">
      <div className="run-compare-subheading"><div><strong>Comparability contract</strong><small>Green rows are identical; differences stay visible rather than being normalized away.</small></div><span>{comparison.differences.length} config difference{comparison.differences.length === 1 ? "" : "s"}</span></div>
      <div className="run-compare-contract">
        <div><span>Dataset revision</span><strong>{a.run.dataset_revision}</strong><strong>{b.run.dataset_revision}</strong><b className={datasetStatus.className}>{datasetStatus.label}</b></div>
        <div><span>Training seed</span><strong>{seedA}</strong><strong>{seedB}</strong><b className={seedStatus.className}>{seedStatus.label}</b></div>
        <div><span>Base model SHA set</span><strong>{modelSignature(a.run) ? "Fingerprint set" : "Unknown"}</strong><strong>{modelSignature(b.run) ? "Fingerprint set" : "Unknown"}</strong><b className={modelStatus.className}>{modelStatus.label}</b></div>
        <div><span>Upstream Fizgig</span><strong>{shortSha(softwareValue(a.run, "fizgig", "commit"))}</strong><strong>{shortSha(softwareValue(b.run, "fizgig", "commit"))}</strong><b className={upstreamStatus.className}>{upstreamStatus.label}</b></div>
        <div><span>fizgig-web</span><strong>{shortSha(softwareValue(a.run, "fizgig_web", "vcs_ref"))}</strong><strong>{shortSha(softwareValue(b.run, "fizgig_web", "vcs_ref"))}</strong><b className={webStatus.className}>{webStatus.label}</b></div>
        <div><span>Observed image order</span><strong title={comparison.scheduleA}>{comparison.scheduleA ? shortSha(comparison.scheduleA) : "—"}</strong><strong title={comparison.scheduleB}>{comparison.scheduleB ? shortSha(comparison.scheduleB) : "—"}</strong><b className={scheduleStatus.className}>{scheduleStatus.label}</b></div>
        <div><span>Image + timestep schedule</span><strong title={comparison.timestepA}>{comparison.timestepA ? shortSha(comparison.timestepA) : "—"}</strong><strong title={comparison.timestepB}>{comparison.timestepB ? shortSha(comparison.timestepB) : "—"}</strong><b className={timestepStatus.className}>{timestepStatus.label}</b></div>
      </div>
      <details className="run-compare-config-diff" open={comparison.differences.length > 0 && comparison.differences.length <= 8}>
        <summary>Exact run configuration differences · {comparison.differences.length}</summary>
        {!comparison.differences.length ? <div className="run-compare-empty compact">No frozen configuration differences.</div> : <div className="run-compare-diff-table">
          <div className="header"><span>Setting</span><strong>Run A</strong><strong>Run B</strong></div>
          {comparison.differences.map((diff) => <div key={diff.path}><code>{diff.path}</code><span title={diff.a}>{diff.a}</span><span title={diff.b}>{diff.b}</span></div>)}
        </div>}
      </details>
    </div>

    <div className="run-compare-subsection">
      <div className="run-compare-subheading">
        <div><strong>Overall training loss</strong><small>Moving-average loss against real global optimizer step. Overlay and split views share the exact same axis bounds.</small></div>
        <div className="run-compare-mode-toggle"><button type="button" className={globalMode === "overlay" ? "active" : ""} onClick={() => setGlobalMode("overlay")}>Overlay</button><button type="button" className={globalMode === "split" ? "active" : ""} onClick={() => setGlobalMode("split")}>Split</button></div>
      </div>
      <div className="run-compare-legend"><span className="run-a">Run A · {a.run.id}</span><span className="run-b">Run B · {b.run.id}</span><small>x = global step · y = moving-average loss</small></div>
      <ComparisonChart a={comparison.globalA} b={comparison.globalB} labelA={a.run.id} labelB={b.run.id} mode={globalMode} emptyText="Neither run has global loss telemetry yet." />
    </div>

    <div className="run-compare-subsection">
      <div className="run-compare-subheading">
        <div><strong>Individual image trajectory</strong><small>Fizgig normalized residual against epoch. The same union-derived axes are used for both runs.</small></div>
        <div className="run-compare-mode-toggle"><button type="button" className={imageMode === "overlay" ? "active" : ""} onClick={() => setImageMode("overlay")}>Overlay</button><button type="button" className={imageMode === "split" ? "active" : ""} onClick={() => setImageMode("split")}>Split</button></div>
      </div>
      <div className="run-compare-asset-picker">
        <button type="button" onClick={() => {
          const index = comparison.assets.indexOf(selectedAsset);
          if (index >= 0) setSelectedAsset(comparison.assets[(index - 1 + comparison.assets.length) % comparison.assets.length]);
        }} disabled={comparison.assets.length < 2}>‹</button>
        <select value={selectedAsset} onChange={(event) => setSelectedAsset(event.target.value)}>{comparison.assets.map((asset) => <option value={asset} key={asset}>{asset}</option>)}</select>
        <button type="button" onClick={() => {
          const index = comparison.assets.indexOf(selectedAsset);
          if (index >= 0) setSelectedAsset(comparison.assets[(index + 1) % comparison.assets.length]);
        }} disabled={comparison.assets.length < 2}>›</button>
      </div>
      <div className="run-compare-selected-asset">
        <div className="run-a">{bindingA?.previewUrl ? <img src={bindingA.previewUrl} alt={`${selectedAsset} in ${a.run.id}`} /> : <div className="run-compare-image-missing">No A preview</div>}<span><strong>Run A</strong><small>{bindingA?.trainingFilename || "Asset not present"}</small></span></div>
        <div className="run-b">{bindingB?.previewUrl ? <img src={bindingB.previewUrl} alt={`${selectedAsset} in ${b.run.id}`} /> : <div className="run-compare-image-missing">No B preview</div>}<span><strong>Run B</strong><small>{bindingB?.trainingFilename || "Asset not present"}</small></span></div>
      </div>
      <div className="run-compare-legend"><span className="run-a">Run A · {a.run.id}</span><span className="run-b">Run B · {b.run.id}</span><small>x = epoch · y = normalized residual</small></div>
      <ComparisonChart a={imageSeriesA} b={imageSeriesB} labelA={a.run.id} labelB={b.run.id} mode={imageMode} showPoints emptyText="This asset does not yet have epoch-boundary trajectory data in either run." />
      <div className="run-compare-decision-cards">
        <div className="run-a"><span>Run A latest</span><strong>{latestA ? `Epoch ${latestA.epoch} · ${latestA.state.verdict || "mid"}` : "No decision"}</strong><small>recommended ×{(stateNumber(latestA?.state, "recommended_multiplier") ?? 1).toFixed(2)} · effective ×{(stateNumber(latestA?.state, "multiplier") ?? 1).toFixed(2)}</small></div>
        <div className="run-b"><span>Run B latest</span><strong>{latestB ? `Epoch ${latestB.epoch} · ${latestB.state.verdict || "mid"}` : "No decision"}</strong><small>recommended ×{(stateNumber(latestB?.state, "recommended_multiplier") ?? 1).toFixed(2)} · effective ×{(stateNumber(latestB?.state, "multiplier") ?? 1).toFixed(2)}</small></div>
      </div>
    </div>

    <div className="run-compare-subsection">
      <div className="run-compare-subheading"><div><strong>Generated sample comparison</strong><small>Matched by epoch and probe index. Seeds are shown independently so an accidental sampling mismatch remains obvious.</small></div><span>{comparison.sampleKeys.length} matched position{comparison.sampleKeys.length === 1 ? "" : "s"}</span></div>
      {!comparison.sampleKeys.length ? <div className="run-compare-empty">Neither run has generated training samples to compare.</div> : <div className="run-compare-sample-grid">
        <div className="header"><strong>Run A · {a.run.id}</strong><strong>Run B · {b.run.id}</strong></div>
        {comparison.sampleKeys.map((key) => {
          const sampleA = comparison.sampleMapA.get(key);
          const sampleB = comparison.sampleMapB.get(key);
          return <div className="run-compare-sample-row" key={key}>
            <div className="run-a">{sampleA ? <img src={sampleA.url} alt={sampleLabel(sampleA)} loading="lazy" /> : <div className="run-compare-sample-missing">Missing</div>}<span><strong>{sampleLabel(sampleA)}</strong><small>{sampleA?.seed === null || sampleA?.seed === undefined ? "" : `Seed ${sampleA.seed}`}</small></span></div>
            <div className="run-b">{sampleB ? <img src={sampleB.url} alt={sampleLabel(sampleB)} loading="lazy" /> : <div className="run-compare-sample-missing">Missing</div>}<span><strong>{sampleLabel(sampleB)}</strong><small>{sampleB?.seed === null || sampleB?.seed === undefined ? "" : `Seed ${sampleB.seed}`}</small></span></div>
          </div>;
        })}
      </div>}
    </div>
  </section>;
}
