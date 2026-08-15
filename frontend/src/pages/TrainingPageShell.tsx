import { useEffect, useMemo, useState } from "react";
import { getRun, getRunTelemetry, type ProjectRunSummary, type TrainingSample } from "../api";
import { useSession } from "../session";
import { TrainingPage } from "./TrainingPage";

const ACTIVE_RUN_STATES = new Set(["starting", "cache_latents", "cache_text", "training"]);

type SampleEpochChoice = "latest" | number;

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
  const [choice, setChoice] = useState<SampleEpochChoice>("latest");
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
    setChoice("latest");
    setLoading(true);
    void refresh();
    if (!ACTIVE_RUN_STATES.has(runStatus)) return () => { cancelled = true; };
    const timer = window.setInterval(() => void refresh(), 3500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, runId, runStatus]);

  const epochs = useMemo(() => [...new Set(samples.flatMap((sample) => sample.epoch === null ? [] : [sample.epoch]))].sort((a, b) => a - b), [samples]);
  const latestEpoch = epochs.length ? epochs[epochs.length - 1] : null;
  const viewedEpoch = choice === "latest" ? latestEpoch : choice;
  const visibleSamples = useMemo(() => {
    if (viewedEpoch === null) return samples;
    return samples.filter((sample) => sample.epoch === viewedEpoch);
  }, [samples, viewedEpoch]);

  return <section className="panel stack training-samples-panel">
    <div className="training-section-heading training-samples-heading">
      <div>
        <p className="eyebrow">Visual evaluation</p>
        <div className="card-title">Generated Training Samples</div>
        <p className="muted">Preview images written by Fizgig are preserved with the run and grouped by training epoch.</p>
      </div>
      <div className="training-samples-controls">
        <span className="training-samples-count">{samples.length} image{samples.length === 1 ? "" : "s"}</span>
        {epochs.length > 0 && <label>View
          <select value={String(choice)} onChange={(event) => setChoice(event.target.value === "latest" ? "latest" : Number(event.target.value))}>
            <option value="latest">Latest · epoch {latestEpoch}</option>
            {epochs.map((epoch) => <option key={epoch} value={epoch}>Epoch {epoch}</option>)}
          </select>
        </label>}
      </div>
    </div>

    {error && <div className="notice error">Unable to load generated samples: {error}</div>}
    {!error && loading && !samples.length && <div className="training-sample-empty">Checking the run for generated preview images…</div>}
    {!error && !loading && !samples.length && <div className="training-sample-empty">
      <strong>No generated preview images were recorded for this run.</strong>
      <span>Fizgig preview output is discovered from the run's <code>sample/</code> or <code>samples/</code> directory. Empty means there are no rendered images to display, not that the project sample definitions were lost.</span>
    </div>}
    {visibleSamples.length > 0 && <div className="training-samples-grid">
      {visibleSamples.map((sample) => <a className="training-sample-card" href={sample.url} target="_blank" rel="noreferrer" key={`${sample.source_dir}/${sample.filename}`} title={sample.filename}>
        <span className="training-sample-image-shell"><img src={sample.url} alt={`${sampleLabel(sample)}${sample.epoch === null ? "" : ` at epoch ${sample.epoch}`}`} /></span>
        <span className="training-sample-copy">
          <strong>{sampleLabel(sample)}</strong>
          <small>{sample.epoch === null ? "Unclassified preview" : `Epoch ${sample.epoch}`}{sample.seed === null ? "" : ` · Seed ${sample.seed}`}</small>
          <code>{sample.filename}</code>
        </span>
      </a>)}
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
