import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getRunTelemetry,
  getTrainingStatus,
  startTraining,
  type DecisionImageState,
  type DecisionSnapshot,
  type RunInfo,
  type TrainingMetric,
  type TrainingTelemetry,
} from "../api";

type Props = {
  projectId: string;
  run: RunInfo;
  onRunChange: (run: RunInfo) => void;
  onError: (message: string) => void;
};

type NumericPoint = { x: number; y: number };
type TelemetryAsset = {
  key: string;
  training_filename: string;
  project_filename: string;
  preview_url: string;
};
type EpochRange = { epoch: number; start: number; end: number };
type ConsoleMode = "tail" | "show";

const VIEW_W = 1000;
const VIEW_H = 250;
const PAD_X = 46;
const PAD_Y = 24;
const CAROUSEL_SIZE = 5;
const ACTIVE_RUN_STATES = new Set(["starting", "cache_latents", "cache_text", "training"]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function metricNumber(row: TrainingMetric, field: string) {
  const value = (row as unknown as Record<string, unknown>)[field];
  return finite(value) ? value : null;
}

function decisionNumber(state: DecisionImageState, field: string) {
  const value = (state as unknown as Record<string, unknown>)[field];
  return finite(value) ? value : null;
}

function eventNumber(event: Record<string, unknown>, field: string) {
  const value = event[field];
  return finite(value) ? value : null;
}

function scaleY(values: number[]): { min: number; max: number; y: (value: number) => number } {
  if (!values.length) return { min: 0, max: 1, y: () => VIEW_H / 2 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (Math.abs(max - min) < 1e-12) {
    const pad = Math.abs(max || 1) * 0.05;
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
  }
  const innerH = VIEW_H - PAD_Y * 2;
  return {
    min,
    max,
    y: (value: number) => PAD_Y + ((max - value) / (max - min)) * innerH,
  };
}

function indexPoints(values: number[]): { points: NumericPoint[]; min: number; max: number } {
  const scale = scaleY(values);
  const innerW = VIEW_W - PAD_X * 2;
  return {
    min: scale.min,
    max: scale.max,
    points: values.map((value, index) => ({
      x: PAD_X + (values.length === 1 ? innerW / 2 : (index / (values.length - 1)) * innerW),
      y: scale.y(value),
    })),
  };
}

function pathFor(points: NumericPoint[]) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function formatNumber(value: number, digits = 4) {
  if (Math.abs(value) > 0 && Math.abs(value) < 0.001) return value.toExponential(2);
  return value.toFixed(digits);
}

function softwareValue(software: Record<string, unknown>, group: string, field: string) {
  const section = software[group];
  if (!section || typeof section !== "object") return "unknown";
  const value = (section as Record<string, unknown>)[field];
  return typeof value === "string" && value ? value : "unknown";
}

function significantDecision(snapshot: DecisionSnapshot) {
  if (snapshot.plateaued) return true;
  return Object.values(snapshot.images).some((image) => ["suspect", "watch", "stuck", "exhausted", "excluded"].includes(image.verdict || ""));
}

function metricKey(row: TrainingMetric) {
  const epoch = metricNumber(row, "epoch") ?? row.epoch;
  const step = metricNumber(row, "step_in_epoch");
  return step === null ? "" : `${epoch}:${step}`;
}

function chooseStepInterval(span: number, pixelWidth: number) {
  if (span <= 0) return 1;
  const targetLabels = Math.max(4, Math.floor(Math.max(320, pixelWidth) / 78));
  const required = span / targetLabels;
  const candidates = [1, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  return candidates.find((value) => value >= required) ?? candidates[candidates.length - 1];
}

function xScale(step: number, minStep: number, maxStep: number) {
  const innerW = VIEW_W - PAD_X * 2;
  if (maxStep <= minStep) return PAD_X + innerW / 2;
  return PAD_X + ((step - minStep) / (maxStep - minStep)) * innerW;
}

function GlobalLossChart({ metrics, decisions, events }: { metrics: TrainingMetric[]; decisions: DecisionSnapshot[]; events: Array<Record<string, unknown>> }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [pixelWidth, setPixelWidth] = useState(900);
  const [showEpochs, setShowEpochs] = useState(true);
  const [showSteps, setShowSteps] = useState(true);

  useEffect(() => {
    const element = shellRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setPixelWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const lossRows = metrics.filter((row) => row.type === "loss" && finite(row.loss_moving_average));
  const contextRows = metrics.filter((row) => row.type === "step_context" && metricNumber(row, "global_step") !== null);
  if (!lossRows.length) return <div className="training-chart-empty">Waiting for the first training loss observation…</div>;

  const contextByEpochStep = new Map<string, TrainingMetric>();
  contextRows.forEach((row) => {
    const key = metricKey(row);
    if (key) contextByEpochStep.set(key, row);
  });

  const observations = lossRows.map((row, index) => {
    const context = contextByEpochStep.get(metricKey(row)) ?? contextRows[index];
    const globalStep = context ? metricNumber(context, "global_step") : null;
    return { row, context, globalStep: globalStep ?? index + 1 };
  });
  const minStep = Math.min(...observations.map((entry) => entry.globalStep));
  const maxStep = Math.max(...observations.map((entry) => entry.globalStep));
  const lossScale = scaleY(observations.map((entry) => entry.row.loss_moving_average as number));
  const lossPoints = observations.map((entry) => ({
    x: xScale(entry.globalStep, minStep, maxStep),
    y: lossScale.y(entry.row.loss_moving_average as number),
  }));

  const lrRows = contextRows.filter((row) => metricNumber(row, "lr") !== null);
  const lrValues = lrRows.map((row) => metricNumber(row, "lr") as number);
  const lrScale = scaleY(lrValues);
  const lrPoints = lrRows.map((row) => ({
    x: xScale(metricNumber(row, "global_step") as number, minStep, maxStep),
    y: lrScale.y(metricNumber(row, "lr") as number),
  }));

  const epochRanges = (() => {
    const grouped = new Map<number, { min: number; max: number }>();
    for (const row of contextRows) {
      const epoch = metricNumber(row, "epoch") ?? row.epoch;
      const step = metricNumber(row, "global_step");
      if (step === null) continue;
      const current = grouped.get(epoch);
      if (current) {
        current.min = Math.min(current.min, step);
        current.max = Math.max(current.max, step);
      } else grouped.set(epoch, { min: step, max: step });
    }
    return [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([epoch, range]) => ({ epoch, start: range.min - 0.5, end: range.max + 0.5 } as EpochRange));
  })();

  const epochEnd = new Map(epochRanges.map((range) => [range.epoch, Math.min(maxStep, range.end - 0.5)]));
  const adaptiveEvents = events.filter((event) => event.type === "adaptive_lr_decision" && event.changed === true);
  const latestLoss = observations[observations.length - 1].row.loss_moving_average as number;
  const latestLr = lrValues.length ? lrValues[lrValues.length - 1] : null;
  const stepInterval = chooseStepInterval(Math.max(1, maxStep - minStep), pixelWidth);
  const stepLabels = new Set<number>();
  if (showSteps) {
    const firstRegular = Math.ceil(minStep / stepInterval) * stepInterval;
    for (let step = firstRegular; step <= maxStep; step += stepInterval) stepLabels.add(step);
    epochRanges.forEach((range) => stepLabels.add(Math.round(Math.min(maxStep, range.end - 0.5))));
  }

  return <div className="training-chart-shell" ref={shellRef}>
    <div className="training-chart-heading">
      <div><strong>Global training loss</strong><small>Loss and LR share the same real global-step x-axis. Vertical orange markers are adaptive-LR changes; per-image decisions are small purple markers at their epoch boundary.</small></div>
      <div className="training-chart-heading-controls">
        <div className="training-chart-toggles">
          <label><input type="checkbox" checked={showEpochs} onChange={(event) => setShowEpochs(event.target.checked)} /> Epochs</label>
          <label><input type="checkbox" checked={showSteps} onChange={(event) => setShowSteps(event.target.checked)} /> Steps</label>
        </div>
        <div className="training-chart-stats"><span>loss <strong>{formatNumber(latestLoss)}</strong></span>{latestLr !== null && <span>LR <strong>{formatNumber(latestLr, 6)}</strong></span>}</div>
      </div>
    </div>
    <svg className="training-chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label="Global training loss and learning-rate trajectory">
      {showEpochs && epochRanges.map((range, index) => {
        const left = xScale(Math.max(minStep, range.start), minStep, maxStep);
        const right = xScale(Math.min(maxStep, range.end), minStep, maxStep);
        return <g key={`epoch-band-${range.epoch}`}>
          <rect className={`training-chart-epoch-band ${index % 2 ? "odd" : "even"}`} x={left} y={PAD_Y} width={Math.max(0, right - left)} height={VIEW_H - PAD_Y * 2} />
          <line className="training-chart-epoch-boundary" x1={right} x2={right} y1={PAD_Y} y2={VIEW_H - PAD_Y} />
          <text className="training-chart-epoch-label" textAnchor="end" x={right - 5} y={PAD_Y + 12}>E{range.epoch}</text>
        </g>;
      })}
      {[0, 1, 2, 3, 4].map((index) => {
        const y = PAD_Y + index * ((VIEW_H - PAD_Y * 2) / 4);
        return <line key={index} className="training-chart-grid-line" x1={PAD_X} x2={VIEW_W - PAD_X} y1={y} y2={y} />;
      })}
      {decisions.filter(significantDecision).map((decision) => {
        const boundary = epochEnd.get(decision.epoch);
        if (boundary === undefined) return null;
        const x = xScale(boundary, minStep, maxStep);
        return <g key={`decision-${decision.epoch}`} className={`training-chart-decision-marker ${decision.plateaued ? "plateau" : ""}`}>
          <line x1={x} x2={x} y1={PAD_Y} y2={PAD_Y + 12} />
          <circle cx={x} cy={PAD_Y + 15} r={3.5}><title>{decision.plateaued ? `Dataset plateau @ epoch ${decision.epoch}` : `Per-image loss-watch decision @ epoch ${decision.epoch}`}</title></circle>
        </g>;
      })}
      {adaptiveEvents.map((event, index) => {
        const epoch = eventNumber(event, "epoch") ?? 1;
        const boundary = epochEnd.get(epoch);
        if (boundary === undefined) return null;
        const x = xScale(boundary, minStep, maxStep);
        return <line key={`adaptive-${epoch}-${index}`} className="training-chart-adaptive-line" x1={x} x2={x} y1={PAD_Y} y2={VIEW_H - PAD_Y}><title>{`Adaptive LR @ epoch ${epoch}: ${String(event.action || "change")} · ${formatNumber(eventNumber(event, "before_lr") ?? 0, 6)} → ${formatNumber(eventNumber(event, "after_lr") ?? 0, 6)} · ${String(event.reason || "")}`}</title></line>;
      })}
      <path className="training-chart-loss-line" d={pathFor(lossPoints)} />
      {lrPoints.length > 1 && <path className="training-chart-lr-line" d={pathFor(lrPoints)} />}
      {showSteps && [...stepLabels].sort((a, b) => a - b).map((step) => {
        const x = xScale(step, minStep, maxStep);
        return <g key={`step-${step}`}>
          <line className="training-chart-step-tick" x1={x} x2={x} y1={VIEW_H - PAD_Y} y2={VIEW_H - PAD_Y + 4} />
          <text className="training-chart-step-label" textAnchor="middle" x={x} y={VIEW_H - 5}>{step}</text>
        </g>;
      })}
      <text className="training-chart-axis-label" x={5} y={PAD_Y + 4}>{formatNumber(lossScale.max)}</text>
      <text className="training-chart-axis-label" x={5} y={VIEW_H - PAD_Y}>{formatNumber(lossScale.min)}</text>
    </svg>
    <div className="training-chart-legend"><span className="loss">Loss MA</span>{lrPoints.length > 1 && <span className="lr">Optimizer LR (normalized y-scale)</span>}<span className="decision">Per-image decision</span>{adaptiveEvents.length > 0 && <span className="adaptive">Adaptive LR change</span>}</div>
    {adaptiveEvents.length > 0 && <div className="training-decision-ribbon adaptive-ribbon">{adaptiveEvents.slice(-8).map((event, index) => {
      const epoch = eventNumber(event, "epoch") ?? 0;
      const before = eventNumber(event, "before_lr") ?? 0;
      const after = eventNumber(event, "after_lr") ?? 0;
      return <span key={`${epoch}-${index}`}><strong>E{epoch}</strong> {String(event.action || "LR change")} · {formatNumber(before, 6)}→{formatNumber(after, 6)}</span>;
    })}</div>}
  </div>;
}

function ImageTrajectoryChart({ selectedAsset, decisions }: { selectedAsset: string; decisions: DecisionSnapshot[] }) {
  const rows = decisions.flatMap((snapshot) => {
    const state = snapshot.images[selectedAsset];
    return state && finite(state.mean_residual) ? [{ snapshot, state }] : [];
  });
  if (!rows.length) return <div className="training-chart-empty">This image does not have an epoch-boundary trajectory yet.</div>;

  const scaled = indexPoints(rows.map((entry) => entry.state.mean_residual as number));
  const epochs = rows.map((entry) => entry.snapshot.epoch);
  const minEpoch = Math.min(...epochs);
  const maxEpoch = Math.max(...epochs);
  const current = rows[rows.length - 1].state;
  const currentRecommended = decisionNumber(current, "recommended_multiplier");
  const currentEffective = decisionNumber(current, "multiplier");
  const verdictChanges = rows.filter((entry, index) => index === 0 || entry.state.verdict !== rows[index - 1].state.verdict);

  return <div className="training-chart-shell">
    <div className="training-chart-heading">
      <div className="training-selected-asset"><strong title={selectedAsset}>{selectedAsset}</strong><small>Re-normalized per-image residual at each Fizgig epoch boundary</small></div>
      <div className="training-chart-stats">
        <span>verdict <strong>{current.verdict || "—"}</strong></span>
        {currentRecommended !== null && <span>recommended <strong>×{currentRecommended.toFixed(3)}</strong></span>}
        <span>effective <strong>×{(currentEffective ?? 1).toFixed(3)}</strong></span>
      </div>
    </div>
    <svg className="training-chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={`Per-image loss trajectory for ${selectedAsset}`}>
      {[0, 1, 2, 3, 4].map((index) => {
        const y = PAD_Y + index * ((VIEW_H - PAD_Y * 2) / 4);
        return <line key={index} className="training-chart-grid-line" x1={PAD_X} x2={VIEW_W - PAD_X} y1={y} y2={y} />;
      })}
      {scaled.min <= 0 && scaled.max >= 0 && <line className="training-chart-zero-line" x1={PAD_X} x2={VIEW_W - PAD_X} y1={PAD_Y + ((scaled.max - 0) / (scaled.max - scaled.min)) * (VIEW_H - PAD_Y * 2)} y2={PAD_Y + ((scaled.max - 0) / (scaled.max - scaled.min)) * (VIEW_H - PAD_Y * 2)} />}
      <path className="training-chart-image-line" d={pathFor(scaled.points)} />
      {rows.map((entry, index) => <circle key={`${entry.snapshot.epoch}-${index}`} className={`training-chart-point verdict-${entry.state.verdict || "mid"}`} cx={scaled.points[index].x} cy={scaled.points[index].y} r={verdictChanges.includes(entry) ? 5 : 3}><title>{`Epoch ${entry.snapshot.epoch}: ${entry.state.verdict || "mid"} · residual ${formatNumber(entry.state.mean_residual as number)} · recommended ×${(decisionNumber(entry.state, "recommended_multiplier") ?? 1).toFixed(2)} · effective ×${(decisionNumber(entry.state, "multiplier") ?? 1).toFixed(2)}`}</title></circle>)}
      <text className="training-chart-axis-label" x={PAD_X} y={VIEW_H - 5}>epoch {minEpoch}</text>
      <text className="training-chart-axis-label" textAnchor="end" x={VIEW_W - PAD_X} y={VIEW_H - 5}>epoch {maxEpoch}</text>
      <text className="training-chart-axis-label" x={5} y={PAD_Y + 4}>{formatNumber(scaled.max)}</text>
      <text className="training-chart-axis-label" x={5} y={VIEW_H - PAD_Y}>{formatNumber(scaled.min)}</text>
    </svg>
    <div className="training-decision-ribbon">{verdictChanges.slice(-8).map((entry) => {
      const recommended = decisionNumber(entry.state, "recommended_multiplier") ?? 1;
      return <span key={`${entry.snapshot.epoch}-${entry.state.verdict}`} className={`verdict-${entry.state.verdict || "mid"}`}><strong>E{entry.snapshot.epoch}</strong> {entry.state.verdict || "mid"} · wants ×{recommended.toFixed(2)}</span>;
    })}</div>
  </div>;
}

function eventDetail(event: Record<string, unknown>) {
  if (event.type === "adaptive_lr_decision") {
    const action = String(event.action || "LR decision");
    const before = eventNumber(event, "before_lr");
    const after = eventNumber(event, "after_lr");
    return `${action}${before !== null && after !== null ? ` · ${formatNumber(before, 6)}→${formatNumber(after, 6)}` : ""}`;
  }
  return String(event.stage || event.time || "");
}

function verdictDisplay(verdict: string | undefined) {
  const value = (verdict || "mid").toLowerCase();
  if (value === "easy") return { code: "E", label: "Easy", className: "easy" };
  if (value === "learning") return { code: "L", label: "Learning", className: "learning" };
  if (value === "watch" || value === "suspect") return { code: "W", label: "Watch", className: "watch" };
  if (value === "stuck") return { code: "S", label: "Stuck", className: "stuck" };
  if (value === "exhausted" || value === "excluded" || value === "retire") return { code: "R", label: "Retire", className: "retire" };
  return { code: "M", label: "Mid", className: "mid" };
}

export function TrainingTelemetryPanel({ projectId, run, onRunChange, onError }: Props) {
  const [telemetry, setTelemetry] = useState<TrainingTelemetry | null>(null);
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [consoleMode, setConsoleMode] = useState<ConsoleMode>("tail");
  const consoleRef = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [status, nextTelemetry] = await Promise.all([
        getTrainingStatus(projectId, run.id),
        getRunTelemetry(projectId, run.id),
      ]);
      onRunChange(status.run);
      setTelemetry(nextTelemetry);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }, [projectId, run.id, onRunChange, onError]);

  useEffect(() => {
    void refresh();
    if (!ACTIVE_RUN_STATES.has(run.status)) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh, run.status]);

  const assetNames = useMemo(() => {
    const names = new Set<string>(Object.keys(telemetry?.trajectories || {}));
    for (const snapshot of telemetry?.decision_history || []) Object.keys(snapshot.images || {}).forEach((name) => names.add(name));
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [telemetry]);

  const telemetryAssets = ((telemetry as (TrainingTelemetry & { assets?: TelemetryAsset[] }) | null)?.assets ?? []);
  const assetMetadata = useMemo(() => new Map(telemetryAssets.map((asset) => [asset.key, asset])), [telemetryAssets]);
  const selectedIndex = selectedAsset ? assetNames.indexOf(selectedAsset) : -1;
  const carouselAssets = useMemo(() => {
    if (!assetNames.length || selectedIndex < 0) return [];
    const count = Math.min(CAROUSEL_SIZE, assetNames.length);
    const radius = Math.floor(count / 2);
    return Array.from({ length: count }, (_, offset) => assetNames[(selectedIndex + offset - radius + assetNames.length) % assetNames.length]);
  }, [assetNames, selectedIndex]);

  useEffect(() => {
    if (!selectedAsset || !assetNames.includes(selectedAsset)) setSelectedAsset(assetNames[0] || "");
  }, [assetNames, selectedAsset]);

  const consoleLastLine = telemetry?.console_tail?.[telemetry.console_tail.length - 1] ?? "";
  useEffect(() => {
    if (consoleMode !== "tail") return;
    const frame = window.requestAnimationFrame(() => {
      const element = consoleRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [consoleMode, consoleLastLine]);

  function navigateAsset(delta: number) {
    if (!assetNames.length || selectedIndex < 0) return;
    setSelectedAsset(assetNames[(selectedIndex + delta + assetNames.length) % assetNames.length]);
  }

  function latestStateFor(name: string) {
    for (let index = (telemetry?.decision_history.length || 0) - 1; index >= 0; index -= 1) {
      const state = telemetry?.decision_history[index]?.images[name];
      if (state) return state;
    }
    return undefined;
  }

  function AssetThumb({ name, compact = false }: { name: string; compact?: boolean }) {
    const metadata = assetMetadata.get(name);
    const state = latestStateFor(name);
    const verdict = verdictDisplay(state?.verdict);
    const effective = decisionNumber(state ?? {}, "multiplier") ?? 1;
    const selected = name === selectedAsset;
    return <button
      type="button"
      className={`training-trajectory-thumb ${compact ? "compact" : ""} ${selected ? "selected" : ""} verdict-${verdict.className}`}
      onClick={() => setSelectedAsset(name)}
      title={`${metadata?.training_filename || name} · ${verdict.label} · effective LR ×${effective.toFixed(2)}`}
    >
      <span className="training-trajectory-thumb-image">
        {metadata?.preview_url ? <img src={metadata.preview_url} alt={metadata.training_filename || name} /> : <span className="training-trajectory-thumb-placeholder">{name.slice(-3)}</span>}
        <span className="training-trajectory-state-letter">{verdict.code}</span>
        <span className="training-trajectory-effective">×{effective.toFixed(2)}</span>
      </span>
      {!compact && <span className="training-trajectory-thumb-name">{metadata?.training_filename || name}</span>}
    </button>;
  }

  function toggleConsoleMode() {
    if (consoleMode === "tail") {
      setConsoleMode("show");
      return;
    }
    setConsoleMode("tail");
    window.requestAnimationFrame(() => {
      const element = consoleRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }

  async function onStart() {
    setStarting(true);
    onError("");
    try {
      const result = await startTraining(projectId, run.id);
      onRunChange(result.run);
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }

  const upstreamSha = softwareValue(telemetry?.software || run.software || {}, "fizgig", "commit");
  const webSha = softwareValue(telemetry?.software || run.software || {}, "fizgig_web", "vcs_ref");
  const canStart = run.status === "prepared" && run.model_family === "krea2";
  const eventRows = (telemetry?.events || []).slice(-10).reverse();
  const latestDecision = selectedAsset
    ? [...(telemetry?.decision_history || [])].reverse().find((snapshot) => snapshot.images[selectedAsset])
    : undefined;
  const latestState = latestDecision?.images[selectedAsset];
  const latestRecommended = latestState ? decisionNumber(latestState, "recommended_multiplier") : null;
  const latestEffective = latestState ? decisionNumber(latestState, "multiplier") : null;
  const lossWatchConfig = ((run.config?.loss_watch ?? {}) as Record<string, unknown>);
  const interventionMode = run.telemetry_mode === "loss_watch_intervention"
    || Boolean(lossWatchConfig.per_image_lr || lossWatchConfig.auto_recaption || lossWatchConfig.warmup_look_outliers);

  return <section className="panel stack training-telemetry-panel">
    <div className="training-section-heading">
      <div><p className="eyebrow">{interventionMode ? "Loss-watch intervention" : "Observation run"}</p><div className="card-title">Training Telemetry</div></div>
      <div className="training-telemetry-actions">
        <span className={`training-run-state ${run.status === "completed" ? "prepared" : "design"}`}>{run.status.toUpperCase()}</span>
        {canStart && <button className="primary" disabled={starting} onClick={() => void onStart()}>{starting ? "Starting…" : "Start Training"}</button>}
        <button className="secondary" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button>
      </div>
    </div>

    <div className="training-baseline-note">{interventionMode
      ? <><strong>Intervention mode.</strong> Fizgig's loss watcher may apply the enabled per-image LR and/or automatic recaption actions. The frozen run policy can constrain individual assets with Always Train, Hold or Never while leaving the underlying verdict visible.</>
      : <><strong>Observation mode.</strong> Per-image trajectories and recommendations are recorded, but no per-image LR or automatic recaption action is enabled for this run.</>}
    </div>

    <div className="training-software-strip">
      <div><span>Upstream Fizgig</span><code title={upstreamSha}>{upstreamSha === "unknown" ? upstreamSha : upstreamSha.slice(0, 12)}</code></div>
      <div><span>fizgig-web</span><code title={webSha}>{webSha === "unknown" ? webSha : webSha.slice(0, 12)}</code></div>
      <div><span>Telemetry</span><strong>{telemetry?.metrics.length || 0} metric rows · {telemetry?.decision_history.length || 0} epoch decisions</strong></div>
    </div>

    <GlobalLossChart metrics={telemetry?.metrics || []} decisions={telemetry?.decision_history || []} events={telemetry?.events || []} />

    <div className="training-trajectory-toolbar">
      <div><strong>Individual trajectory</strong><small>Uses Fizgig's epoch-boundary normalized residual, rather than comparing raw diffusion loss across unrelated timesteps. Thumbnail letters show the latest state; the small value is the effective LR multiplier.</small></div>
      <div className="training-trajectory-navigator">
        <button type="button" className="training-trajectory-browser-toggle" onClick={() => setBrowserOpen((open) => !open)} aria-expanded={browserOpen}><span>{browserOpen ? "Hide dataset" : `Browse all ${assetNames.length}`}</span><span className={`caption-browser-chevron ${browserOpen ? "open" : ""}`}>⌄</span></button>
        <div className="training-trajectory-carousel-row">
          <button type="button" className="training-trajectory-arrow" onClick={() => navigateAsset(-1)} disabled={assetNames.length < 2} aria-label="Previous training asset">‹</button>
          <div className="training-trajectory-carousel-strip">{carouselAssets.map((name) => <AssetThumb key={name} name={name} compact />)}</div>
          <button type="button" className="training-trajectory-arrow" onClick={() => navigateAsset(1)} disabled={assetNames.length < 2} aria-label="Next training asset">›</button>
        </div>
      </div>
    </div>
    {browserOpen && <div className="training-trajectory-browser"><div className="training-trajectory-browser-grid">{assetNames.map((name) => <AssetThumb key={name} name={name} />)}</div></div>}
    {selectedAsset ? <ImageTrajectoryChart selectedAsset={selectedAsset} decisions={telemetry?.decision_history || []} /> : <div className="training-chart-empty">Per-image trajectories appear after Fizgig has enough observations to classify the dataset.</div>}

    {latestDecision && latestState && <div className="training-current-decision">
      <span>Latest selected-image decision</span>
      <strong>Epoch {latestDecision.epoch} · {latestState.verdict || "mid"}</strong>
      <small>Fizgig recommendation ×{(latestRecommended ?? 1).toFixed(2)} · effective ×{(latestEffective ?? 1).toFixed(2)}. Recommended and effective values are kept separate so Auto and Always Train behavior can be compared directly.</small>
    </div>}

    <div className="training-telemetry-contract">
      <div><strong>Dense global observations</strong><code>metrics.jsonl</code><small>loss, moving-average loss, optimizer LR, sampled timestep and asset identity</small></div>
      <div><strong>Raw per-image observations</strong><code>loss_log/per_image_loss.jsonl</code><small>asset, timestep, raw loss, bucket residual and EMA</small></div>
      <div><strong>Epoch decisions</strong><code>loss_log/decision_history.jsonl</code><small>normalized trend, verdict, multiplier recommendation, plateau and best-epoch estimate</small></div>
      <div><strong>Audit trail</strong><code>events.jsonl + console.log</code><small>adaptive-LR decisions, command lifecycle and timestamped stdout/stderr; charts never depend on parsing console text</small></div>
    </div>

    <div className="training-runtime-details">
      <div className="training-event-list"><strong>Recent run events</strong>{eventRows.length ? eventRows.map((event, index) => <div key={`${String(event.time || "")}-${index}`}><span>{String(event.type || "event")}</span><small title={String(event.reason || "")}>{eventDetail(event)}</small></div>) : <span className="muted">No run events yet.</span>}</div>
      <div className="training-console-tail">
        <div className="training-console-heading"><strong>Persistent console tail</strong><button type="button" className={`training-console-mode ${consoleMode}`} onClick={toggleConsoleMode} title={consoleMode === "tail" ? "Stop following the live tail" : "Follow the live tail and jump to the newest output"}>{consoleMode.toUpperCase()}</button></div>
        <pre ref={consoleRef} onScroll={(event) => {
          if (consoleMode !== "tail") return;
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 20;
          if (!atBottom) setConsoleMode("show");
        }}>{telemetry?.console_tail.length ? telemetry.console_tail.join("\n") : "No console output yet."}</pre>
      </div>
    </div>
  </section>;
}
