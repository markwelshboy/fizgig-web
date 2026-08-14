import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getImagePrepState,
  getProject,
  getProjectRevisionPolicy,
  getTrainingFilenames,
  prepareRun,
  type ImagePrepState,
  type ProjectRevisionPolicy,
  type TrainingFilenameState,
} from "../api";
import { getCaptionMethodologies, type CaptionMethodologyPayload } from "../caption-methodologies-api";
import { getCaptionStatus, type CaptionStatusState } from "../caption-runtime-api";
import { useSession } from "../session";

type PrecisionMode = "fp8" | "bf16" | "nf4";
type CompileMode = "auto" | "off" | "on";

function numberValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function modelLabel(value: string) {
  if (value === "krea2") return "Krea 2";
  if (value === "klein") return "Klein";
  return value || "Model";
}

export function TrainingPage() {
  const navigate = useNavigate();
  const {
    project,
    setProject,
    revision,
    run,
    setRun,
    modelFamily,
    triggerWord,
  } = useSession();

  const [prep, setPrep] = useState<ImagePrepState | null>(null);
  const [captionStatus, setCaptionStatus] = useState<CaptionStatusState | null>(null);
  const [policy, setPolicy] = useState<ProjectRevisionPolicy | null>(null);
  const [trainingNames, setTrainingNames] = useState<TrainingFilenameState | null>(null);
  const [methodologies, setMethodologies] = useState<CaptionMethodologyPayload | null>(null);
  const [loadingReadiness, setLoadingReadiness] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");

  const [runName, setRunName] = useState("");
  const [rank, setRank] = useState("32");
  const [alpha, setAlpha] = useState("32");
  const [epochs, setEpochs] = useState("30");
  const [saveEvery, setSaveEvery] = useState("1");
  const [seed, setSeed] = useState("42");
  const [targetMegapixels, setTargetMegapixels] = useState("1.0");
  const [batchSize, setBatchSize] = useState("1");
  const [gradientAccumulation, setGradientAccumulation] = useState("1");
  const [maxGradNorm, setMaxGradNorm] = useState("1.0");
  const [keepLast, setKeepLast] = useState("4");

  const [adaptiveLr, setAdaptiveLr] = useState(true);
  const [learningRate, setLearningRate] = useState("0.0001");
  const [minLr, setMinLr] = useState("0.0001");
  const [maxLr, setMaxLr] = useState("0.0004");
  const [optimizer, setOptimizer] = useState("adamw");
  const [precision, setPrecision] = useState<PrecisionMode>("fp8");
  const [compileMode, setCompileMode] = useState<CompileMode>("auto");
  const [cachePreparation, setCachePreparation] = useState(true);
  const [detectProblems, setDetectProblems] = useState(true);
  const [perImageLr, setPerImageLr] = useState(true);
  const [warmupLookOutliers, setWarmupLookOutliers] = useState(false);
  const [autoRecaption, setAutoRecaption] = useState(true);

  const activeModelFamily = revision?.model_family && revision.model_family !== "generic"
    ? revision.model_family
    : modelFamily;
  const activeTrigger = (project?.trigger_word || triggerWord || "").trim();
  const methodologyMap = useMemo(() => new Map(
    methodologies ? [...methodologies.builtins, ...methodologies.customs].map((method) => [method.id, method]) : [],
  ), [methodologies]);

  useEffect(() => {
    if (!project || !revision) {
      setPrep(null);
      setCaptionStatus(null);
      setPolicy(null);
      setTrainingNames(null);
      setMethodologies(null);
      return;
    }

    setRunName((current) => current || `${project.name} — ${modelLabel(activeModelFamily)}`);
    let cancelled = false;
    setLoadingReadiness(true);
    setError("");

    Promise.all([
      getImagePrepState(project.id, revision.id),
      getCaptionStatus(project.id, revision.id),
      getProjectRevisionPolicy(project.id, revision.id),
      getTrainingFilenames(project.id, revision.id),
      getCaptionMethodologies(),
    ])
      .then(([nextPrep, nextCaptionStatus, nextPolicy, nextTrainingNames, nextMethodologies]) => {
        if (cancelled) return;
        setPrep(nextPrep);
        setCaptionStatus(nextCaptionStatus);
        setPolicy(nextPolicy);
        setTrainingNames(nextTrainingNames);
        setMethodologies(nextMethodologies);
        setTargetMegapixels(String(nextPrep.training_resolution?.max_megapixels ?? 1.0));
      })
      .catch((exc) => {
        if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc));
      })
      .finally(() => {
        if (!cancelled) setLoadingReadiness(false);
      });

    return () => { cancelled = true; };
  }, [project?.id, revision?.id, activeModelFamily]);

  const readiness = useMemo(() => {
    const assets = (revision?.assets ?? []).filter((asset) => asset.included !== false);
    let saved = 0;
    let triggerWarnings = 0;
    let spellingWarnings = 0;
    let protectedWarnings = 0;
    let alwaysTrain = 0;
    let holdRecaption = 0;
    let lockRecaption = 0;

    for (const asset of assets) {
      if (asset.caption.trim()) saved += 1;
      const status = captionStatus?.statuses[asset.filename];
      if (status?.trigger_state === "missing" || status?.trigger_state === "case_mismatch") triggerWarnings += 1;
      if ((status?.spelling_issue_count ?? 0) > 0) spellingWarnings += 1;
      if ((status?.protected_matches.length ?? 0) > 0) protectedWarnings += 1;
      const itemPolicy = policy?.assets[asset.filename];
      if (itemPolicy?.training_policy === "always_train") alwaysTrain += 1;
      if (itemPolicy?.auto_recaption_policy === "hold") holdRecaption += 1;
      if (itemPolicy?.auto_recaption_policy === "never") lockRecaption += 1;
    }

    const includedNames = new Set(assets.map((asset) => asset.filename));
    const bucketMap = new Map<string, number>();
    for (const item of prep?.resolution_assets ?? []) {
      if (!includedNames.has(item.filename)) continue;
      const key = `${item.bucket_width}×${item.bucket_height}`;
      bucketMap.set(key, (bucketMap.get(key) ?? 0) + 1);
    }

    return {
      total: assets.length,
      saved,
      missing: Math.max(0, assets.length - saved),
      triggerWarnings,
      spellingWarnings,
      protectedWarnings,
      alwaysTrain,
      holdRecaption,
      lockRecaption,
      buckets: Array.from(bucketMap.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [revision, prep, captionStatus, policy]);

  const canPrepare = Boolean(project && revision && readiness.total > 0 && readiness.missing === 0 && !preparing);
  const rewriteLadder = methodologies?.rewrite_ladder ?? [];

  async function onPrepareRun() {
    if (!project || !revision || !canPrepare) return;
    setPreparing(true);
    setError("");
    try {
      const prepared = await prepareRun(project.id, {
        name: runName.trim() || `${project.name} — ${modelLabel(activeModelFamily)}`,
        model_family: activeModelFamily,
        dataset_revision: revision.id,
        trigger_word: activeTrigger,
        config: {
          schema_version: 1,
          source: "fizgig-web-training-harness",
          network: {
            type: "lora",
            rank: numberValue(rank, 32),
            alpha: numberValue(alpha, 32),
          },
          training: {
            max_epochs: numberValue(epochs, 30),
            seed: numberValue(seed, 42),
            save_every_n_epochs: numberValue(saveEvery, 1),
            keep_last_states: numberValue(keepLast, 4),
            target_megapixels: numberValue(targetMegapixels, 1.0),
            cache_preparation: cachePreparation,
          },
          optimizer: {
            type: optimizer,
            gradient_accumulation: numberValue(gradientAccumulation, 1),
            max_grad_norm: numberValue(maxGradNorm, 1.0),
          },
          learning_rate: adaptiveLr
            ? {
                mode: "adaptive",
                min_lr: numberValue(minLr, 0.0001),
                max_lr: numberValue(maxLr, 0.0004),
              }
            : {
                mode: "fixed",
                lr: numberValue(learningRate, 0.0001),
              },
          dataset: {
            batch_size: numberValue(batchSize, 1),
            caption_extension: ".txt",
            enable_bucket: prep?.training_resolution?.enable_bucket ?? true,
            bucket_no_upscale: prep?.training_resolution?.bucket_no_upscale ?? true,
            training_filename_mode: trainingNames?.policy.mode ?? "original",
          },
          runtime: {
            base_precision: precision,
            compile_blocks: compileMode,
          },
          loss_watch: {
            detect_problem_images: detectProblems,
            per_image_lr: perImageLr,
            warmup_look_outliers: warmupLookOutliers,
            auto_recaption: autoRecaption,
            rewrite_ladder: rewriteLadder,
            intervention_policy: "Per-image Hold/Never suppresses automatic rewrite stages without changing the analytic loss verdict.",
          },
          telemetry: {
            persistent_console_log: true,
            metrics_jsonl: true,
            per_image_loss_jsonl: detectProblems || perImageLr,
          },
        },
      });
      setRun(prepared);
      setProject(await getProject(project.id));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setPreparing(false);
    }
  }

  if (!project || !revision) {
    return <div className="stack training-harness-page">
      <header className="page-header">
        <div><p className="eyebrow">Training harness</p><h1>Training</h1><p className="muted">Open a project and prepare a dataset revision before configuring a training run.</p></div>
      </header>
      <section className="panel training-empty-state">
        <strong>No active dataset revision</strong>
        <p className="muted">The harness is project-owned so run settings, captions, transforms, filenames, and telemetry remain reproducible.</p>
        <button className="primary" onClick={() => navigate("/")}>Go to Start</button>
      </section>
    </div>;
  }

  return <div className="stack training-harness-page">
    <header className="page-header training-harness-header">
      <div>
        <p className="eyebrow">Training harness · first pass</p>
        <h1>Training</h1>
        <p className="muted">Prepare a reproducible run around the dataset intelligence we have been uncovering. The trainer subprocess and live telemetry adapter are the next wiring step; this page does not fake an active run.</p>
      </div>
      <div className="training-header-badges">
        <span className="badge">{modelLabel(activeModelFamily)}</span>
        <span className={`training-run-state ${run ? "prepared" : "design"}`}>{run ? `${run.id} PREPARED` : "RUN DESIGN"}</span>
      </div>
    </header>

    {error && <div className="training-error" role="alert">{error}</div>}

    <section className="panel stack training-readiness-panel">
      <div className="training-section-heading">
        <div><p className="eyebrow">Gate 1</p><div className="card-title">Dataset Readiness</div></div>
        <div className="actions">
          <button className="secondary" onClick={() => navigate("/image-prep")}>Image Prep</button>
          <button className="secondary" onClick={() => navigate("/captions")}>Review Captions</button>
        </div>
      </div>

      <div className="training-readiness-grid">
        <div className="training-readiness-card"><span>Included images</span><strong>{loadingReadiness ? "…" : readiness.total}</strong><small>{revision.id}</small></div>
        <div className={`training-readiness-card ${readiness.missing ? "warn" : "good"}`}><span>Saved captions</span><strong>{loadingReadiness ? "…" : `${readiness.saved}/${readiness.total}`}</strong><small>{readiness.missing ? `${readiness.missing} must be completed before preparing a run` : "Ready"}</small></div>
        <div className={`training-readiness-card ${!activeTrigger || readiness.triggerWarnings ? "warn" : "good"}`}><span>Trigger binding</span><strong>{activeTrigger || "None"}</strong><small>{!activeTrigger ? "No project trigger configured" : readiness.triggerWarnings ? `${readiness.triggerWarnings} caption warning${readiness.triggerWarnings === 1 ? "" : "s"}` : "No trigger warnings"}</small></div>
        <div className="training-readiness-card"><span>Training names</span><strong>{trainingNames?.policy.mode === "normalized" ? "Normalized" : "Original"}</strong><small>{trainingNames?.policy.mode === "normalized" ? `${trainingNames.policy.basename || activeTrigger || "dataset"}_… .png` : "Project filenames preserved"}</small></div>
      </div>

      <div className="training-readiness-detail-grid">
        <div className="training-mini-panel">
          <strong>Resolution buckets</strong>
          <div className="training-chip-row">
            {readiness.buckets.length ? readiness.buckets.slice(0, 6).map(([bucket, count]) => <span className="training-chip" key={bucket}>{bucket} · {count}</span>) : <span className="muted">No resolved buckets yet</span>}
          </div>
          <small className="muted">Target {prep?.training_resolution?.max_megapixels ?? targetMegapixels} MP · {prep?.training_resolution?.bucket_no_upscale !== false ? "downscale only" : "upscale allowed"}</small>
        </div>
        <div className="training-mini-panel">
          <strong>Caption / intervention review</strong>
          <div className="training-chip-row">
            {readiness.spellingWarnings > 0 && <span className="training-chip warning">{readiness.spellingWarnings} spelling</span>}
            {readiness.protectedWarnings > 0 && <span className="training-chip warning">{readiness.protectedWarnings} protected</span>}
            {readiness.alwaysTrain > 0 && <span className="training-chip">{readiness.alwaysTrain} Always Train</span>}
            {readiness.holdRecaption > 0 && <span className="training-chip">{readiness.holdRecaption} Hold</span>}
            {readiness.lockRecaption > 0 && <span className="training-chip">{readiness.lockRecaption} Lock</span>}
            {!readiness.spellingWarnings && !readiness.protectedWarnings && !readiness.alwaysTrain && !readiness.holdRecaption && !readiness.lockRecaption && <span className="muted">No interventions currently recorded</span>}
          </div>
          <small className="muted">Manual caption decisions remain first-class training policy rather than being overwritten at run time.</small>
        </div>
      </div>
    </section>

    <section className="panel stack training-config-panel">
      <div className="training-section-heading">
        <div><p className="eyebrow">Gate 2</p><div className="card-title">Run Configuration</div></div>
        <span className="muted">Defaults mirror the Krea 2 configuration we have been testing.</span>
      </div>

      <div className="training-config-grid">
        <label className="training-span-2">Run name<input value={runName} onChange={(event) => setRunName(event.target.value)} /></label>
        <label>Model<input value={modelLabel(activeModelFamily)} disabled /></label>
        <label>Target MP<input type="number" min="0.1" step="0.1" value={targetMegapixels} onChange={(event) => setTargetMegapixels(event.target.value)} /></label>
        <label>Network rank<input type="number" min="1" value={rank} onChange={(event) => setRank(event.target.value)} /></label>
        <label>Network alpha<input type="number" min="1" value={alpha} onChange={(event) => setAlpha(event.target.value)} /></label>
        <label>Epochs<input type="number" min="1" value={epochs} onChange={(event) => setEpochs(event.target.value)} /></label>
        <label>Seed<input type="number" value={seed} onChange={(event) => setSeed(event.target.value)} /></label>
      </div>

      <div className="training-subsection">
        <div className="training-subsection-title">Learning rate</div>
        <label className="training-toggle"><input type="checkbox" checked={adaptiveLr} onChange={(event) => setAdaptiveLr(event.target.checked)} /> <span><strong>Adaptive LR</strong><small>Start between Min/Max, respond to plateau and weight-norm growth.</small></span></label>
        <div className="training-config-grid compact">
          {adaptiveLr ? <>
            <label>Min LR<input value={minLr} onChange={(event) => setMinLr(event.target.value)} /></label>
            <label>Max LR<input value={maxLr} onChange={(event) => setMaxLr(event.target.value)} /></label>
          </> : <label>Learning rate<input value={learningRate} onChange={(event) => setLearningRate(event.target.value)} /></label>}
          <label>Optimizer<select value={optimizer} onChange={(event) => setOptimizer(event.target.value)}><option value="adamw">AdamW</option></select></label>
          <label>Max grad norm<input value={maxGradNorm} onChange={(event) => setMaxGradNorm(event.target.value)} /></label>
        </div>
      </div>

      <div className="training-subsection">
        <div className="training-subsection-title">Dataset & runtime</div>
        <div className="training-config-grid compact">
          <label>Batch size<input type="number" min="1" value={batchSize} onChange={(event) => setBatchSize(event.target.value)} /></label>
          <label>Gradient accumulation<input type="number" min="1" value={gradientAccumulation} onChange={(event) => setGradientAccumulation(event.target.value)} /></label>
          <label>Save every N epochs<input type="number" min="1" value={saveEvery} onChange={(event) => setSaveEvery(event.target.value)} /></label>
          <label>Keep last states<input type="number" min="1" value={keepLast} onChange={(event) => setKeepLast(event.target.value)} /></label>
          <label>Base precision<select value={precision} onChange={(event) => setPrecision(event.target.value as PrecisionMode)}><option value="fp8">FP8</option><option value="bf16">BF16</option><option value="nf4">NF4</option></select></label>
          <label>Compile blocks<select value={compileMode} onChange={(event) => setCompileMode(event.target.value as CompileMode)}><option value="auto">Auto</option><option value="off">Off</option><option value="on">On</option></select></label>
        </div>
        <label className="training-toggle"><input type="checkbox" checked={cachePreparation} onChange={(event) => setCachePreparation(event.target.checked)} /> <span><strong>Prepare latent / text caches</strong><small>Enabled by default for a fresh run.</small></span></label>
      </div>
    </section>

    <section className="panel stack training-intelligence-panel">
      <div className="training-section-heading">
        <div><p className="eyebrow">Gate 3</p><div className="card-title">Dataset Intelligence</div></div>
        <span className="badge">Per-image first</span>
      </div>

      <div className="training-policy-grid">
        <label className="training-policy-card selected">
          <input type="checkbox" checked={detectProblems} onChange={(event) => setDetectProblems(event.target.checked)} />
          <span><strong>Track individual losses</strong><small>Persist image-level loss history so difficult examples are observable instead of disappearing inside average loss.</small></span>
        </label>
        <label className={`training-policy-card ${perImageLr ? "selected" : ""}`}>
          <input type="checkbox" checked={perImageLr} onChange={(event) => setPerImageLr(event.target.checked)} />
          <span><strong>Per-image adaptive LR</strong><small>Throttle confirmed stuck examples while preserving healthy, improving examples at full learning rate.</small></span>
        </label>
        <label className={`training-policy-card ${warmupLookOutliers ? "selected" : ""}`}>
          <input type="checkbox" checked={warmupLookOutliers} onChange={(event) => setWarmupLookOutliers(event.target.checked)} />
          <span><strong>Warm-up look outliers</strong><small>Optional curriculum signal for Image Prep look-consistency outliers. Off until we wire scoring into the project.</small></span>
        </label>
        <label className={`training-policy-card ${autoRecaption ? "selected" : ""}`}>
          <input type="checkbox" checked={autoRecaption} onChange={(event) => setAutoRecaption(event.target.checked)} />
          <span><strong>Automatic caption resolution</strong><small>When a confirmed stuck image is eligible, apply the explicit three-stage methodology ladder configured in Preferences. Hold/Never images are skipped.</small></span>
        </label>
      </div>

      <div className="training-rewrite-ladder">
        <div><strong>Rewrite ladder</strong><button className="secondary" type="button" onClick={() => navigate("/preferences#caption-methodologies")}>Configure</button></div>
        <div className="training-chip-row">{rewriteLadder.length ? rewriteLadder.map((id, index) => <span className="training-chip" key={`${id}-${index}`}>Stage {index + 1} · {methodologyMap.get(id)?.name ?? id}</span>) : <span className="muted">Loading caption methodologies…</span>}</div>
        <small className="muted">The complete methodology definitions, hashes, rendered project variables and stage order are frozen into the prepared run snapshot.</small>
      </div>

      <div className="training-principle-note">
        <strong>Policy:</strong> high loss is evidence to inspect, not an automatic reason to discard an image. Hard-but-learning, stuck, caption-mismatched, exhausted, and manually protected images need distinct states.
      </div>
    </section>

    <section className="panel stack training-prepare-panel">
      <div className="training-section-heading">
        <div><p className="eyebrow">Gate 4</p><div className="card-title">Prepare Reproducible Run</div></div>
        <span className={canPrepare ? "status-good" : "status-suspect"}>{canPrepare ? "READY TO PREPARE" : "READINESS BLOCKED"}</span>
      </div>

      {!canPrepare && <div className="training-blockers">
        {readiness.total === 0 && <span>No included training images.</span>}
        {readiness.missing > 0 && <span>{readiness.missing} included image{readiness.missing === 1 ? " has" : "s have"} no saved caption.</span>}
        {preparing && <span>Preparing run snapshot…</span>}
      </div>}

      <div className="training-prepare-summary">
        <div><span>Dataset revision</span><strong>{revision.id}</strong></div>
        <div><span>Images</span><strong>{readiness.total}</strong></div>
        <div><span>Trigger</span><strong>{activeTrigger || "—"}</strong></div>
        <div><span>Loss watch</span><strong>{detectProblems ? "On" : "Off"}</strong></div>
      </div>

      <div className="actions">
        <button className="secondary" onClick={() => navigate("/samples")}>Back to Sampling</button>
        <button className="primary" disabled={!canPrepare} onClick={() => void onPrepareRun()}>{preparing ? "Preparing…" : "Prepare Training Run"}</button>
      </div>
    </section>

    {run && <section className="panel stack training-prepared-run">
      <div className="training-section-heading">
        <div><p className="eyebrow">Prepared run</p><div className="card-title">{run.id} · {run.name}</div></div>
        <span className="training-run-state prepared">PREPARED</span>
      </div>
      <div className="training-run-paths">
        <div><span>Run directory</span><code>{run.output_dir}</code></div>
        <div><span>Materialized trainer dataset</span><code>{run.dataset_path}</code></div>
      </div>
      <p className="muted">This snapshot is now project-owned. Starting the Fizgig subprocess will become a separate explicit action so configuration, launch, pause/resume, and failure state remain auditable.</p>
    </section>}

    <section className="panel stack training-telemetry-panel">
      <div className="training-section-heading">
        <div><p className="eyebrow">Next wiring step</p><div className="card-title">Training Telemetry Contract</div></div>
        <span className="muted">No fake progress data</span>
      </div>
      <div className="training-telemetry-grid">
        <div><strong>Global training</strong><code>metrics.jsonl</code><small>epoch, step, loss, LR, gradient clipping, weight-norm movement</small></div>
        <div><strong>Per-image loss</strong><code>loss_log/per_image_loss.jsonl</code><small>asset identity, loss trend, verdict, LR multiplier, recaption / exclusion state</small></div>
        <div><strong>Persistent console</strong><code>console.log</code><small>timestamped command, stdout/stderr, lifecycle and exit markers; Copy / Download in the UI</small></div>
        <div><strong>Run events</strong><code>events.jsonl</code><small>stuck, recaption stage/methodology, manual edit, checkpoint, sample, plateau, pause/resume and final outcome</small></div>
      </div>
    </section>

    {project.runs.length > 0 && <section className="panel stack training-history-panel">
      <div className="card-title">Recent Project Runs</div>
      <div className="training-history-list">
        {project.runs.slice(-5).reverse().map((item) => <div key={item.id}><span><strong>{item.id}</strong> · {item.name}</span><span>{item.status} · {modelLabel(item.model_family)}</span></div>)}
      </div>
    </section>}
  </div>;
}
