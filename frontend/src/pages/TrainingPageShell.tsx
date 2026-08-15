import { useEffect, useMemo, useState } from "react";
import { deleteRun, getProject, getRun, getRunTelemetry, stopTraining, type ProjectRunSummary, type TrainingSample } from "../api";
import { useSession } from "../session";
import { TrainingPage } from "./TrainingPage";

const ACTIVE_RUN_STATES = new Set(["starting", "cache_latents", "cache_text", "training", "stopping"]);

function modelLabel(value: string) {
  if (value === "krea2") return "Krea 2";
  if (value === "klein") return "Klein";
  return value || "Model";
}

function sampleLabel(sample: TrainingSample) {
  if (sample.sample_index !== null) return `Probe ${sample.sample_index + 1}`;
  return sample.filename;
}

function RunSampleGallery({ projectId, runId, runStatus }: { projectId: string; runId: string; runStatus: string }) {
  const [samples, setSamples] = useState<TrainingSample[]>([]);
  const [viewing, setViewing] = useState<TrainingSample | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const telemetry = await getRunTelemetry(projectId, runId);
        if (!cancelled) {
          setSamples(telemetry.samples ?? []);
          setError("");
        }
      } catch (exc) {
        if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    setSamples([]);
    setViewing(null);
    setLoading(true);
    void refresh();
    if (!ACTIVE_RUN_STATES.has(runStatus)) return () => { cancelled = true; };
    const timer = window.setInterval(() => void refresh(), 3500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, runId, runStatus]);

  const epochGroups = useMemo(() => {
    const groups = new Map<number | null, TrainingSample[]>();
    for (const sample of samples) {
      if (!groups.has(sample.epoch)) groups.set(sample.epoch, []);
      groups.get(sample.epoch)!.push(sample);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => {
        if (a === null) return 1;
        if (b === null) return -1;
        return a - b;
      })
      .map(([epoch, rows]) => ({
        epoch,
        samples: rows.sort((a, b) => (a.sample_index ?? 9999) - (b.sample_index ?? 9999)),
      }));
  }, [samples]);

  return <section className="panel stack training-samples-panel">
    <div className="training-section-heading training-samples-heading">
      <div>
        <p className="eyebrow">Visual evaluation</p>
        <div className="card-title">Generated Training Samples</div>
        <p className="muted">Each epoch starts a new visual row. Rows wrap only when the previews would otherwise become too small, and alternating bands make epoch boundaries obvious.</p>
      </div>
      <span className="training-samples-count">{samples.length} image{samples.length === 1 ? "" : "s"}</span>
    </div>

    {error && <div className="notice error">Unable to load generated samples: {error}</div>}
    {!error && loading && !samples.length && <div className="training-sample-empty">Checking the run for generated preview images…</div>}
    {!error && !loading && !samples.length && <div className="training-sample-empty">
      <strong>No generated preview images were recorded for this run.</strong>
      <span>New Krea runs can use Fizgig's native in-training preview generator when the project Sampling plan is enabled.</span>
    </div>}

    {epochGroups.length > 0 && <div className="training-sample-epochs">
      {epochGroups.map((group, groupIndex) => <div className="training-sample-epoch-row" key={group.epoch === null ? "other" : group.epoch}>
        <div className="training-sample-epoch-label">
          <span>{group.epoch === null ? "Other" : "Epoch"}</span>
          <strong>{group.epoch === null ? "—" : group.epoch}</strong>
          <small>{group.samples.length} preview{group.samples.length === 1 ? "" : "s"}</small>
        </div>
        <div className="training-sample-epoch-images" aria-label={group.epoch === null ? "Unclassified training samples" : `Epoch ${group.epoch} training samples`}>
          {group.samples.map((sample) => <button className="training-sample-card" type="button" onClick={() => setViewing(sample)} key={`${sample.source_dir}/${sample.filename}`} title={`View ${sample.filename}`}>
            <span className="training-sample-image-shell"><img src={sample.url} alt={`${sampleLabel(sample)}${sample.epoch === null ? "" : ` at epoch ${sample.epoch}`}`} loading={groupIndex > 3 ? "lazy" : "eager"} /></span>
            <span className="training-sample-copy">
              <strong>{sampleLabel(sample)}</strong>
              <small>{sample.seed === null ? "" : `Seed ${sample.seed}`}</small>
            </span>
          </button>)}
        </div>
      </div>)}
    </div>}

    {viewing && <div className="training-sample-viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewing(null); }}>
      <div className="training-sample-viewer" role="dialog" aria-modal="true" aria-label={`Training sample ${viewing.filename}`}>
        <div className="training-sample-viewer-header">
          <div><strong>{sampleLabel(viewing)}</strong><span>{viewing.epoch === null ? "Unclassified preview" : `Epoch ${viewing.epoch}`}{viewing.seed === null ? "" : ` · Seed ${viewing.seed}`}</span></div>
          <button type="button" onClick={() => setViewing(null)} aria-label="Close sample viewer"><i className="ti ti-x" /></button>
        </div>
        <div className="training-sample-viewer-image"><img src={viewing.url} alt={viewing.filename} /></div>
        <code>{viewing.filename}</code>
      </div>
    </div>}
  </section>;
}

type RunHistoryProps = {
  runs: ProjectRunSummary[];
  selectedRunId?: string;
  openingRunId: string | null;
  actionSelection: Set<string>;
  deleting: boolean;
  stoppingRunId: string | null;
  onReview: (runId: string) => void;
  onToggle: (runId: string, checked: boolean) => void;
  onDelete: () => void;
  onStop: (runId: string) => void;
};

function RunHistory({ runs, selectedRunId, openingRunId, actionSelection, deleting, stoppingRunId, onReview, onToggle, onDelete, onStop }: RunHistoryProps) {
  const selectedCount = actionSelection.size;
  return <section className="panel stack training-run-browser-panel">
    <div className="training-section-heading training-run-browser-heading">
      <div><p className="eyebrow">Project history</p><div className="card-title">Training Runs</div><p className="muted">Open any preserved run to review its immutable snapshot, telemetry, console output and generated samples. Select completed/stopped runs for purge or future comparison.</p></div>
      <div className="training-run-browser-header-actions">
        {selectedCount > 0 && <div className="training-run-selection-actions">
          {selectedCount === 2 && <button type="button" className="secondary" disabled title="Run comparison plumbing is the next step.">Compare</button>}
          <button type="button" className="danger" disabled={deleting} onClick={onDelete}>{deleting ? "Deleting…" : `Delete ${selectedCount}`}</button>
        </div>}
        <span className="training-samples-count">{runs.length} run{runs.length === 1 ? "" : "s"}</span>
      </div>
    </div>
    <div className="training-run-browser-list">
      {[...runs].reverse().map((item) => {
        const viewing = selectedRunId === item.id;
        const opening = openingRunId === item.id;
        const active = ACTIVE_RUN_STATES.has(item.status);
        const stopping = stoppingRunId === item.id || item.status === "stopping";
        const checked = actionSelection.has(item.id);
        return <div className={`training-run-browser-row ${viewing ? "selected" : ""} ${checked ? "action-selected" : ""}`} key={item.id}>
          <button type="button" className="training-run-browser-review" onClick={() => onReview(item.id)} disabled={opening}>
            <span className="training-run-browser-identity"><strong>{item.id}</strong><span>{item.name}</span><small>Dataset {item.dataset_revision}</small></span>
            <span className="training-run-browser-status"><span>{item.status}</span><small>{modelLabel(item.model_family)}</small><b>{opening ? "Opening…" : viewing ? "Viewing" : "Review"}</b></span>
          </button>
          <div className="training-run-browser-row-actions">
            {active && <button type="button" className="training-run-stop" disabled={stopping} onClick={() => onStop(item.id)}>{stopping ? "Stopping…" : "Stop"}</button>}
            <label className={`training-run-select ${active ? "disabled" : ""}`} title={active ? "Stop this run before selecting it for deletion." : "Select run"}>
              <input type="checkbox" checked={checked} disabled={active || deleting} onChange={(event) => onToggle(item.id, event.target.checked)} />
              <span className="sr-only">Select {item.id}</span>
            </label>
          </div>
        </div>;
      })}
    </div>
  </section>;
}

export function TrainingPageShell() {
  const { project, setProject, run, setRun } = useSession();
  const [openingRunId, setOpeningRunId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [actionSelection, setActionSelection] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);

  const visibleRuns = useMemo(() => (project?.runs ?? []).filter((item) => item.status !== "deleted"), [project?.runs]);

  useEffect(() => {
    if (!project?.current_run || run) return;
    let cancelled = false;
    setOpeningRunId(project.current_run);
    getRun(project.id, project.current_run)
      .then((selected) => { if (!cancelled) setRun(selected); })
      .catch((exc) => { if (!cancelled) setHistoryError(exc instanceof Error ? exc.message : String(exc)); })
      .finally(() => { if (!cancelled) setOpeningRunId(null); });
    return () => { cancelled = true; };
  }, [project?.id, project?.current_run, run?.id, setRun]);

  useEffect(() => {
    const available = new Set(visibleRuns.map((item) => item.id));
    setActionSelection((current) => new Set([...current].filter((id) => available.has(id))));
  }, [visibleRuns]);

  async function reviewRun(runId: string) {
    if (!project) return;
    setOpeningRunId(runId);
    setHistoryError("");
    try {
      const selected = await getRun(project.id, runId);
      setRun(selected);
      window.setTimeout(() => {
        document.querySelector(".training-prepared-run")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } catch (exc) {
      setHistoryError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setOpeningRunId(null);
    }
  }

  function toggleRun(runId: string, checked: boolean) {
    setActionSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(runId); else next.delete(runId);
      return next;
    });
  }

  async function stopRun(runId: string) {
    if (!project) return;
    const summary = visibleRuns.find((item) => item.id === runId);
    if (!summary || !ACTIVE_RUN_STATES.has(summary.status)) return;
    if (!window.confirm(`Stop ${runId}? The active Fizgig process will be terminated. Partial telemetry, checkpoints and generated samples will be preserved.`)) return;
    setStoppingRunId(runId);
    setHistoryError("");
    try {
      const result = await stopTraining(project.id, runId);
      if (run?.id === runId) setRun(result.run);
      const refreshed = await getProject(project.id);
      setProject(refreshed);
    } catch (exc) {
      setHistoryError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setStoppingRunId(null);
    }
  }

  async function deleteSelectedRuns() {
    if (!project || actionSelection.size === 0) return;
    const ids = [...actionSelection];
    const label = ids.length === 1 ? ids[0] : `${ids.length} runs`;
    if (!window.confirm(`Permanently purge ${label}? This removes run-owned telemetry, generated samples, checkpoints/state and final LoRA files. Project assets and dataset revisions are not deleted.`)) return;
    setDeleting(true);
    setHistoryError("");
    try {
      for (const runId of ids) await deleteRun(project.id, runId);
      const refreshed = await getProject(project.id);
      setProject(refreshed);
      setActionSelection(new Set());
      if (run && ids.includes(run.id)) {
        if (refreshed.current_run) {
          try { setRun(await getRun(project.id, refreshed.current_run)); }
          catch { setRun(null); }
        } else setRun(null);
      }
    } catch (exc) {
      setHistoryError(exc instanceof Error ? exc.message : String(exc));
      try { setProject(await getProject(project.id)); } catch { /* keep the current project if refresh fails */ }
    } finally {
      setDeleting(false);
    }
  }

  return <div className="stack training-page-shell">
    <TrainingPage />
    {run && project && <RunSampleGallery projectId={project.id} runId={run.id} runStatus={run.status} />}
    {historyError && <div className="training-error" role="alert">{historyError}</div>}
    {project && visibleRuns.length > 0 && <RunHistory
      runs={visibleRuns}
      selectedRunId={run?.id}
      openingRunId={openingRunId}
      actionSelection={actionSelection}
      deleting={deleting}
      stoppingRunId={stoppingRunId}
      onReview={(runId) => void reviewRun(runId)}
      onToggle={toggleRun}
      onDelete={() => void deleteSelectedRuns()}
      onStop={(runId) => void stopRun(runId)}
    />}
  </div>;
}
