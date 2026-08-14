import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getRunTelemetry,
  getTrainingStatus,
  startTraining,
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

const VIEW_W = 1000;
const VIEW_H = 250;
const PAD_X = 46;
const PAD_Y = 24;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function scalePoints(values: number[]): { points: NumericPoint[]; min: number; max: number } {
  if (!values.length) return { points: [], min: 0, max: 1 };
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
  const innerW = VIEW_W - PAD_X * 2;
  const innerH = VIEW_H - PAD_Y * 2;
  return {
    min,
    max,
    points: values.map((value, index) => ({
      x: PAD_X + (values.length === 1 ? innerW / 2 : (index / (values.length - 1)) * innerW),
      y: PAD_Y + ((max - value) / (max - min)) * innerH,
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

function GlobalLossChart({ metrics, decisions }: { metrics: TrainingMetric[]; decisions: DecisionSnapshot[] }) {
  const lossRows = metrics.filter((row) => row.type === "loss" && finite(row.loss_moving_average));
  const lrRows = metrics.filter((row) => row.type === "step_context" && finite(row.lr));
  if (!lossRows.length) return <div className="training-chart-empty">Waiting for the first training loss observation…</div>;

  const loss = scalePoints(lossRows.map((row) => row.loss_moving_average as number));
  const lr = scalePoints(lrRows.map((row) => row.lr as number));
  const maxEpoch = Math.max(1, ...lossRows.map((row) => finite(row.epoch) ? row.epoch : 1), ...decisions.map((row) => row.epoch));
  const latestLoss = lossRows[lossRows.length - 1].loss_moving_average as number;
  const latestLr = lrRows.length ? lrRows[lrRows.length - 1].lr as number : null;

  return <div className="training-chart-shell">
    <div className="training-chart-heading">
      <div><strong>Global training loss</strong><small>Fizgig moving average · direct trainer observation</small></div>
      <div className="training-chart-stats"><span>loss <strong>{formatNumber(latestLoss)}</strong></span>{latestLr !== null && <span>LR <strong>{formatNumber(latestLr, 6)}</strong></span>}</div>
    </div>
    <svg className="training-chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label="Global training loss and learning-rate trajectory">
      {[0, 1, 2, 3, 4].map((index) => {
        const y = PAD_Y + index * ((VIEW_H - PAD_Y * 2) / 4);
        return <line key={index} className="training-chart-grid-line" x1={PAD_X} x2={VIEW_W - PAD_X} y1={y} y2={y} />;
      })}
      {decisions.filter(significantDecision).map((decision) => {
        const x = PAD_X + (decision.epoch / maxEpoch) * (VIEW_W - PAD_X * 2);
        return <line key={`decision-${decision.epoch}`} className={`training-chart-decision-line ${decision.plateaued ? "plateau" : ""}`} x1={x} x2={x} y1={PAD_Y} y2={VIEW_H - PAD_Y}><title>{decision.plateaued ? `Plateau @ epoch ${decision.epoch}` : `Loss-watch decision @ epoch ${decision.epoch}`}</title></line>;
      })}
      <path className="training-chart-loss-line" d={pathFor(loss.points)} />
      {lr.points.length > 1 && <path className="training-chart-lr-line" d={pathFor(lr.points)} />}
      <text className="training-chart-axis-label" x={PAD_X} y={VIEW_H - 5}>start</text>
      <text className="training-chart-axis-label" textAnchor="end" x={VIEW_W - PAD_X} y={VIEW_H - 5}>epoch {maxEpoch}</text>
      <text className="training-chart-axis-label" x={5} y={PAD_Y + 4}>{formatNumber(loss.max)}</text>
      <text className="training-chart-axis-label" x={5} y={VIEW_H - PAD_Y}>{formatNumber(loss.min)}</text>
    </svg>
    <div className="training-chart-legend"><span className="loss">Loss MA</span>{lr.points.length > 1 && <span className="lr">Optimizer LR (normalized scale)</span>}<span className="decision">Decision boundary</span></div>
  </div>;
}

function ImageTrajectoryChart({ selectedAsset, decisions }: { selectedAsset: string; decisions: DecisionSnapshot[] }) {
  const rows = decisions
    .map((snapshot) => ({ snapshot, state: snapshot.images[selectedAsset] }))
    .filter((entry) => entry.state && finite(entry.state.mean_residual));
  if (!rows.length) return <div className="training-chart-empty">This image does not have an epoch-boundary trajectory yet.</div>;

  const scaled = scalePoints(rows.map((entry) => entry.state.mean_residual as number));
  const epochs = rows.map((entry) => entry.snapshot.epoch);
  const minEpoch = Math.min(...epochs);
  const maxEpoch = Math.max(...epochs);
  const current = rows[rows.length - 1].state;
  const verdictChanges = rows.filter((entry, index) => index === 0 || entry.state.verdict !== rows[index - 1].state.verdict);

  return <div className="training-chart-shell">
    <div className="training-chart-heading">
      <div className="training-selected-asset"><strong title={selectedAsset}>{selectedAsset}</strong><small>Re-normalized per-image residual at each Fizgig epoch boundary</small></div>
      <div className="training-chart-stats"><span>verdict <strong>{current.verdict || "—"}</strong></span><span>multiplier <strong>×{finite(current.multiplier) ? current.multiplier.toFixed(3) : "1.000"}</strong></span></div>
    </div>
    <svg className="training-chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={`Per-image loss trajectory for ${selectedAsset}`}>
      {[0, 1, 2, 3, 4].map((index) => {
        const y = PAD_Y + index * ((VIEW_H - PAD_Y * 2) / 4);
        return <line key={index} className="training-chart-grid-line" x1={PAD_X} x2={VIEW_W - PAD_X} y1={y} y2={y} />;
      })}
      {scaled.min <= 0 && scaled.max >= 0 && <line className="training-chart-zero-line" x1={PAD_X} x2={VIEW_W - PAD_X} y1={PAD_Y + ((scaled.max - 0) / (scaled.max - scaled.min)) * (VIEW_H - PAD_Y * 2)} y2={PAD_Y + ((scaled.max - 0) / (scaled.max - scaled.min)) * (VIEW_H - PAD_Y * 2)} />}
      <path className="training-chart-image-line" d={pathFor(scaled.points)} />
      {rows.map((entry, index) => <circle key={`${entry.snapshot.epoch}-${index}`} className={`training-chart-point verdict-${entry.state.verdict || "mid"}`} cx={scaled.points[index].x} cy={scaled.points[index].y} r={verdictChanges.includes(entry) ? 5 : 3}><title>{`Epoch ${entry.snapshot.epoch}: ${entry.state.verdict || "mid"} · residual ${formatNumber(entry.state.mean_residual as number)}`}</title></circle>)}
      <text className="training-chart-axis-label" x={PAD_X} y={VIEW_H - 5}>epoch {minEpoch}</text>
      <text className="training-chart-axis-label" textAnchor="end" x={VIEW_W - PAD_X} y={VIEW_H - 5}>epoch {maxEpoch}</text>
      <text className="training-chart-axis-label" x={5} y={PAD_Y + 4}>{formatNumber(scaled.max)}</text>
      <text className="training-chart-axis-label" x={5} y={VIEW_H - PAD_Y}>{formatNumber(scaled.min)}</text>
    </svg>
    <div className="training-decision-ribbon">{verdictChanges.slice(-8).map((entry) => <span key={`${entry.snapshot.epoch}-${entry.state.verdict}`} className={`verdict-${entry.state.verdict || "mid"}`}><strong>E{entry.snapshot.epoch}</strong> {entry.state.verdict || "mid"}{finite(entry.state.multiplier) ? ` ×${entry.state.multiplier.toFixed(2)}` : ""}</span>)}</div>
  </div>;
}

export function TrainingTelemetryPanel({ projectId, run, onRunChange, onError }: Props) {
  const [telemetry, setTelemetry] = useState<TrainingTelemetry | null>(null);
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState("");

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
    const active = !["completed", "failed"].includes(run.status);
    if (!active) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh, run.status]);

  const assetNames = useMemo(() => {
    const names = new Set<string>(Object.keys(telemetry?.trajectories || {}));
    for (const snapshot of telemetry?.decision_history || []) Object.keys(snapshot.images || {}).forEach((name) => names.add(name));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [telemetry]);

  useEffect(() => {
    if (!selectedAsset || !assetNames.includes(selectedAsset)) setSelectedAsset(assetNames[0] || "");
  }, [assetNames, selectedAsset]);

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

  return <section className="panel stack training-telemetry-panel">
    <div className="training-section-heading">
      <div><p className="eyebrow">Observer baseline</p><div className="card-title">Training Telemetry</div></div>
      <div className="training-telemetry-actions">
        <span className={`training-run-state ${run.status === "completed" ? "prepared" : "design"}`}>{run.status.toUpperCase()}</span>
        {canStart && <button className="primary" disabled={starting} onClick={() => void onStart()}>{starting ? "Starting…" : "Start Baseline Training"}</button>}
        <button className="secondary" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button>
      </div>
    </div>

    <div className="training-baseline-note"><strong>Observation only.</strong> This run enables Fizgig's loss watcher so we can see its evidence and verdicts, but the web launcher does not enable per-image LR, auto-recaption, look-outlier warm-up, exclusions, or web policy overrides. This is the A/B baseline before we allow the harness to shape training.</div>

    <div className="training-software-strip">
      <div><span>Upstream Fizgig</span><code title={upstreamSha}>{upstreamSha === "unknown" ? upstreamSha : upstreamSha.slice(0, 12)}</code></div>
      <div><span>fizgig-web</span><code title={webSha}>{webSha === "unknown" ? webSha : webSha.slice(0, 12)}</code></div>
      <div><span>Telemetry</span><strong>{telemetry?.metrics.length || 0} metric rows · {telemetry?.decision_history.length || 0} epoch decisions</strong></div>
    </div>

    <GlobalLossChart metrics={telemetry?.metrics || []} decisions={telemetry?.decision_history || []} />

    <div className="training-trajectory-toolbar">
      <div><strong>Individual trajectory</strong><small>Uses Fizgig's epoch-boundary normalized residual, rather than comparing raw diffusion loss across unrelated timesteps.</small></div>
      <label>Asset<select value={selectedAsset} disabled={!assetNames.length} onChange={(event) => setSelectedAsset(event.target.value)}>{assetNames.length ? assetNames.map((name) => <option key={name} value={name}>{name}</option>) : <option value="">Waiting for images…</option>}</select></label>
    </div>
    {selectedAsset ? <ImageTrajectoryChart selectedAsset={selectedAsset} decisions={telemetry?.decision_history || []} /> : <div className="training-chart-empty">Per-image trajectories appear after Fizgig has enough observations to classify the dataset.</div>}

    {latestDecision && <div className="training-current-decision">
      <span>Latest selected-image decision</span>
      <strong>Epoch {latestDecision.epoch} · {latestDecision.images[selectedAsset]?.verdict || "mid"}</strong>
      <small>Analytic verdict only in this baseline. No web intervention is applied.</small>
    </div>}

    <div className="training-telemetry-contract">
      <div><strong>Dense global observations</strong><code>metrics.jsonl</code><small>loss, moving-average loss, optimizer LR, sampled timestep and asset identity</small></div>
      <div><strong>Raw per-image observations</strong><code>loss_log/per_image_loss.jsonl</code><small>asset, timestep, raw loss, bucket residual and EMA</small></div>
      <div><strong>Epoch decisions</strong><code>loss_log/decision_history.jsonl</code><small>normalized trend, verdict, multiplier recommendation, plateau and best-epoch estimate</small></div>
      <div><strong>Audit trail</strong><code>events.jsonl + console.log</code><small>command lifecycle plus timestamped stdout/stderr; charts never depend on parsing console text</small></div>
    </div>

    <div className="training-runtime-details">
      <div className="training-event-list"><strong>Recent run events</strong>{eventRows.length ? eventRows.map((event, index) => <div key={`${String(event.time || "")}-${index}`}><span>{String(event.type || "event")}</span><small>{String(event.stage || event.time || "")}</small></div>) : <span className="muted">No run events yet.</span>}</div>
      <details className="training-console-tail"><summary>Persistent console tail</summary><pre>{telemetry?.console_tail.length ? telemetry.console_tail.join("\n") : "No console output yet."}</pre></details>
    </div>
  </section>;
}
