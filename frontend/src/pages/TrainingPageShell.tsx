import { useEffect, useMemo, useState } from "react";
import { getRun, getRunTelemetry, type ProjectRunSummary, type TrainingSample } from "../api";
import { useSession } from "../session";
import { TrainingPage } from "./TrainingPage";

const ACTIVE_RUN_STATES = new Set(["starting", "cache_latents", "cache_text", "training"]);

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
      <span>New Krea runs can now use Fizgig's native in-training preview generator when the project Sampling plan is enabled and compatible with the standalone preview options.</span>
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

function RunHistory({ runs, selectedRunId, openingRunId, onReview }: { runs: ProjectRunSummary[]; selectedRunId?: string; openingRunId: string | null; onReview: (runId: string) => void }) {
  return <section className="panel stack training-run-browser-panel">
    <div className="training-section-heading">
      <div><p className="eyebrow">Project history</p><div className="card-title">Training Runs</div><p className="muted">Open any preserved run to review its immutable snapshot, telemetry, console output and generated samples. Its saved configuration also becomes the editable template for the next prepared run.</p></div>
      <span className="training-samples-count">{runs.length} run{runs.length === 1 ? "" : "s"}</span>
    </div>
    <div className="training-run-browser-list">
      {[...runs].reverse().map((item) => {
        const selected = selectedRunId === item.id;
        const opening = openingRunId === item.id;
        return <button type="button" className={`training-run-browser-row ${selected ? "selected" : ""}`} key={item.id} onClick={() => onReview(item.id)} disabled={opening}>
          <span className="training-run-browser-identity"><strong>{item.id}</strong><span>{item.name}</span><small>Dataset {item.dataset_revision}</small></span>
          <span className="training-run-browser-status"><span>{item.status}</span><small>{modelLabel(item.model_family)}</small><b>{opening ? "Opening…" : selected ? "Viewing" : "Review"}</b></span>
        </button>;
      })}
    </div>
  </section>;
}

export function TrainingPageShell() {
  const { project, run, setRun } = useSession();
  const [openingRunId, setOpeningRunId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState("");

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

  return <div className="stack training-page-shell">
    <TrainingPage />
    {run && project && <RunSampleGallery projectId={project.id} runId={run.id} runStatus={run.status} />}
    {historyError && <div className="training-error" role="alert">Unable to open historical run: {historyError}</div>}
    {project && project.runs.length > 0 && <RunHistory runs={project.runs} selectedRunId={run?.id} openingRunId={openingRunId} onReview={(runId) => void reviewRun(runId)} />}
  </div>;
}
