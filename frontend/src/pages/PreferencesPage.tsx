import { useEffect, useMemo, useState } from "react";
import { downloadQwenModel, getModelDownload, getPreferences, savePreferences, type Preferences } from "../api";
import { CaptionMethodologySettings } from "../components/CaptionMethodologySettings";
import {
  downloadTrainingModelFamily,
  getTrainingModelDownload,
  getTrainingModelState,
  type TrainingModelDownloadJob,
  type TrainingModelState,
} from "../training-models-api";

type AppPreferences = Preferences & {
  training_model_dir: string;
  krea2_raw_dit: string;
  krea2_text_encoder: string;
  krea2_vae: string;
  krea2_turbo_lora: string;
  krea2_turbo_dit: string;
  base_dit: string;
  text_encoder: string;
  vae: string;
  distilled_dit: string;
  log_with: string;
  wandb_api_key: string;
  wandb_entity: string;
  wandb_project: string;
  wandb_run_pattern: string;
};

type PreferenceTab = "vlm" | "models" | "tracking" | "paths" | "training" | "advanced";

const QWEN_CAPTION_PRESETS = [
  { value: "Qwen/Qwen3-VL-4B-Instruct", label: "Qwen3-VL 4B Instruct" },
  { value: "Qwen/Qwen3-VL-8B-Instruct", label: "Qwen3-VL 8B Instruct" },
  { value: "Qwen/Qwen3-VL-32B-Instruct", label: "Qwen3-VL 32B Instruct" },
] as const;
const CUSTOM_QWEN_PRESET = "__custom__";

function qwenPresetValue(value: string) {
  return QWEN_CAPTION_PRESETS.some((preset) => preset.value === value) ? value : CUSTOM_QWEN_PRESET;
}

const DEFAULTS: AppPreferences = {
  qwen_caption_model: "Qwen/Qwen3-VL-8B-Instruct",
  qwen_caption_processor: "",
  qwen_caption_revision: "",
  caption_model_dir: "/workspace/models/captioning",
  training_model_dir: "/workspace/models/training",
  krea2_raw_dit: "",
  krea2_text_encoder: "",
  krea2_vae: "",
  krea2_turbo_lora: "",
  krea2_turbo_dit: "",
  base_dit: "",
  text_encoder: "",
  vae: "",
  distilled_dit: "",
  log_with: "all",
  wandb_api_key: "",
  wandb_entity: "",
  wandb_project: "fizgig",
  wandb_run_pattern: "{project}-{model}-{run_id}",
};

const TAB_HASH: Record<PreferenceTab, string> = {
  vlm: "vlm-captioning",
  models: "training-models",
  tracking: "tracking-logging",
  paths: "paths",
  training: "training-defaults",
  advanced: "advanced",
};

function tabFromHash(): PreferenceTab {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "training-models") return "models";
  if (hash === "tracking-logging") return "tracking";
  if (hash === "paths") return "paths";
  if (hash === "training-defaults") return "training";
  if (hash === "advanced") return "advanced";
  if (hash === "caption-methodologies" || hash === "vlm-captioning") return "vlm";
  return "vlm";
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatBytes(value: number | undefined) {
  if (!value || value <= 0) return "";
  const gb = value / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(value / (1024 ** 2)).toFixed(0)} MB`;
}

function formatGigabytes(value: number) {
  if (value < 1) return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(1).replace(/\.0$/, "");
}

export function PreferencesPage() {
  const [tab, setTab] = useState<PreferenceTab>(() => tabFromHash());
  const [prefs, setPrefs] = useState<AppPreferences>(DEFAULTS);
  const [trainingModels, setTrainingModels] = useState<TrainingModelState | null>(null);
  const [downloadRepo, setDownloadRepo] = useState("Qwen/Qwen3-VL-8B-Instruct");
  const [downloadRevision, setDownloadRevision] = useState("");
  const [saving, setSaving] = useState(false);
  const [qwenBusy, setQwenBusy] = useState(false);
  const [trainingJob, setTrainingJob] = useState<TrainingModelDownloadJob | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    Promise.all([getPreferences(), getTrainingModelState()])
      .then(([value, modelState]) => {
        const next = { ...DEFAULTS, ...(value as AppPreferences) };
        setPrefs(next);
        setTrainingModels(modelState);
        if (!next.qwen_caption_model.startsWith("/")) setDownloadRepo(next.qwen_caption_model);
      })
      .catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load preferences"));
  }, []);

  const activeTrainingFamily = trainingJob?.family
    ? trainingModels?.families.find((family) => family.id === trainingJob.family)
    : null;
  const trainingProgress = useMemo(() => {
    if (!trainingJob) return null;
    if ((trainingJob.bytes_total ?? 0) > 0) {
      return Math.max(0, Math.min(100, Math.round(((trainingJob.bytes_done ?? 0) / (trainingJob.bytes_total ?? 1)) * 100)));
    }
    if ((trainingJob.total_assets ?? 0) > 0) {
      return Math.max(0, Math.min(100, Math.round(((trainingJob.completed_assets ?? 0) / (trainingJob.total_assets ?? 1)) * 100)));
    }
    return 0;
  }, [trainingJob]);

  function patch<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
    setPrefs((current) => ({ ...current, [key]: value }));
  }

  function patchString(key: keyof AppPreferences, value: string) {
    setPrefs((current) => ({ ...current, [key]: value }));
  }

  function chooseTab(next: PreferenceTab) {
    setTab(next);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${TAB_HASH[next]}`);
  }

  async function refreshPreferencesAndModels() {
    const [nextPrefs, nextModels] = await Promise.all([getPreferences(), getTrainingModelState()]);
    setPrefs({ ...DEFAULTS, ...(nextPrefs as AppPreferences) });
    setTrainingModels(nextModels);
  }

  async function onSave() {
    setSaving(true);
    setMessage("");
    try {
      const next = await savePreferences(prefs);
      setPrefs({ ...DEFAULTS, ...(next as AppPreferences) });
      setTrainingModels(await getTrainingModelState());
      setMessage("Preferences saved. Any loaded caption model was unloaded so the new VLM selection is used next time.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save preferences");
    } finally {
      setSaving(false);
    }
  }

  async function onDownloadQwen() {
    setQwenBusy(true);
    setMessage(`Queueing ${downloadRepo}…`);
    try {
      let job = await downloadQwenModel({
        repo_id: downloadRepo,
        revision: downloadRevision,
        model_dir: prefs.caption_model_dir,
        use_as_qwen_caption_model: true,
      });
      setMessage(`Downloading ${job.repo_id}…`);
      while (job.status === "queued" || job.status === "running") {
        await wait(1500);
        job = await getModelDownload(job.id);
        setMessage(job.phase === "selecting" ? `Selecting downloaded ${job.repo_id}…` : `Downloading ${job.repo_id}…`);
      }
      if (job.status === "failed") throw new Error(job.error || "Model download failed");
      await refreshPreferencesAndModels();
      setMessage(`Downloaded and selected ${job.repo_id}: ${job.path}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Model download failed");
    } finally {
      setQwenBusy(false);
    }
  }

  async function onDownloadTrainingFamily(family: string) {
    setMessage("");
    try {
      let job = await downloadTrainingModelFamily(family, prefs.training_model_dir);
      setTrainingJob(job);
      while (job.status === "queued" || job.status === "running") {
        await wait(1500);
        job = await getTrainingModelDownload(job.id);
        setTrainingJob(job);
      }
      if (job.status === "failed") throw new Error(job.error || `${family} model download failed`);
      await refreshPreferencesAndModels();
      setMessage(`${family === "krea2" ? "Krea 2" : "Klein"} model bundle is ready in ${job.model_dir}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Training model download failed");
    }
  }

  const operationBusy = saving || qwenBusy || Boolean(trainingJob && (trainingJob.status === "queued" || trainingJob.status === "running"));

  return (
    <div className="stack preferences-page">
      <header className="page-header">
        <div><p className="eyebrow">Application</p><h1>Preferences</h1><p className="muted">Keep caption VLMs, training models, and experiment tracking deliberately separate.</p></div>
        <div className="actions"><button className="primary" onClick={onSave} disabled={operationBusy}>{saving ? "Saving…" : "Save Preferences"}</button></div>
      </header>

      <div className="tabs preferences-tabs" role="tablist">
        <button className={`tab ${tab === "vlm" ? "active" : ""}`} onClick={() => chooseTab("vlm")}>VLM Captioning</button>
        <button className={`tab ${tab === "models" ? "active" : ""}`} onClick={() => chooseTab("models")}>Models</button>
        <button className={`tab ${tab === "tracking" ? "active" : ""}`} onClick={() => chooseTab("tracking")}>Tracking & Logging</button>
        <button className={`tab ${tab === "paths" ? "active" : ""}`} onClick={() => chooseTab("paths")}>Paths</button>
        <button className={`tab ${tab === "training" ? "active" : ""}`} onClick={() => chooseTab("training")}>Training Defaults</button>
        <button className={`tab ${tab === "advanced" ? "active" : ""}`} onClick={() => chooseTab("advanced")}>Advanced</button>
      </div>

      {message && <div className={message.toLowerCase().includes("failed") || message.toLowerCase().includes("unable") || message.toLowerCase().includes("error") ? "notice error" : "notice success"}>{message}</div>}

      {tab === "vlm" && <div className="stack preferences-tab-panel" id="vlm-captioning">
        <section className="panel stack preferences-download-flow">
          <div>
            <p className="eyebrow">Install / cache</p>
            <div className="card-title">Caption VLM download</div>
            <p className="muted">Optional. Download a Hugging Face Qwen3-VL checkpoint into persistent workspace storage and select it as the caption VLM. A Hub ID can also be used directly without downloading here.</p>
          </div>
          <div className="preferences-download-grid">
            <label>Qwen3-VL preset<select value={qwenPresetValue(downloadRepo)} onChange={(event) => { if (event.target.value !== CUSTOM_QWEN_PRESET) setDownloadRepo(event.target.value); }}>
              {QWEN_CAPTION_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
              <option value={CUSTOM_QWEN_PRESET}>Custom Hugging Face repository…</option>
            </select></label>
            <label>Hugging Face repository<input value={downloadRepo} onChange={(event) => setDownloadRepo(event.target.value)} placeholder="Qwen/Qwen3-VL-8B-Instruct" /></label>
            <label>Revision <span className="muted">Optional</span><input value={downloadRevision} onChange={(event) => setDownloadRevision(event.target.value)} placeholder="main" /></label>
            <label>Destination<input value={prefs.caption_model_dir} onChange={(event) => patch("caption_model_dir", event.target.value)} /></label>
            <div className="preferences-download-action"><button className="primary" onClick={onDownloadQwen} disabled={operationBusy || !downloadRepo.trim()}>{qwenBusy ? "Downloading…" : "Download & Select"}</button></div>
          </div>
          {downloadRepo === "Qwen/Qwen3-VL-32B-Instruct" && <div className="notice">Qwen3-VL 32B uses the same captioning path, but it is a much larger checkpoint. Make sure the pod has enough GPU/host memory before loading it.</div>}
        </section>

        <section className="panel stack">
          <div>
            <div className="card-title">Caption VLM — Qwen3-VL</div>
            <p className="muted">This model only describes dataset images. It is independent of Krea 2 and Klein's training text encoders.</p>
          </div>
          <label>Model preset<select value={qwenPresetValue(prefs.qwen_caption_model)} onChange={(event) => { if (event.target.value !== CUSTOM_QWEN_PRESET) patch("qwen_caption_model", event.target.value); }}>
            {QWEN_CAPTION_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
            <option value={CUSTOM_QWEN_PRESET}>Custom model / local checkpoint…</option>
          </select></label>
          <label>Active caption model / checkpoint<input value={prefs.qwen_caption_model} onChange={(event) => patch("qwen_caption_model", event.target.value)} placeholder="Qwen/Qwen3-VL-8B-Instruct or /workspace/models/captioning/..." /></label>
          {prefs.qwen_caption_model === "Qwen/Qwen3-VL-32B-Instruct" && <div className="notice">32B is selected. Saving Preferences unloads any currently loaded caption VLM; the 32B model will be loaded lazily on the next caption request.</div>}
        </section>

        <CaptionMethodologySettings />
      </div>}

      {tab === "models" && <div className="stack preferences-tab-panel" id="training-models">
        <section className="panel stack training-model-root-panel">
          <div className="preferences-section-heading">
            <div><p className="eyebrow">Training runtime</p><div className="card-title">Training model storage</div><p className="muted">These are the actual DiT/text-encoder/VAE weights used by Fizgig training and preview flows—not the caption VLM.</p></div>
            <span className={`preferences-status-pill ${trainingModels?.hf_token_available ? "good" : "neutral"}`}>{trainingModels?.hf_token_available ? "HF_TOKEN AVAILABLE" : "HF_TOKEN NOT SET"}</span>
          </div>
          <label>Training model directory<input value={prefs.training_model_dir} onChange={(event) => patch("training_model_dir", event.target.value)} /></label>
        </section>

        <div className="training-model-family-grid">
          {trainingModels?.families.map((family) => <section className="panel stack training-model-family" key={family.id}>
            <div className="preferences-section-heading">
              <div><div className="card-title">{family.name}</div><p className="muted">{family.ready ? "Core training weights are configured." : "One or more core training weights are missing."}</p></div>
              <span className={`preferences-status-pill ${family.ready ? "good" : "warn"}`}>{family.ready ? "READY" : "SETUP REQUIRED"}</span>
            </div>
            {family.gated && <div className="notice">Klein uses gated Black Forest Labs repositories. Accept the model licences on Hugging Face and provide <code>HF_TOKEN</code> to the pod before downloading.</div>}
            <div className="training-model-assets">
              {family.assets.map((asset) => <div className={`training-model-asset ${asset.exists ? "ready" : "missing"}`} key={asset.key}>
                <div><strong>{asset.label}</strong><small>{asset.core ? "Training core" : "Preview / workbench support"} · ~{formatGigabytes(asset.size_gb)} GB · {asset.filename}</small></div>
                <span>{asset.exists ? "Found" : "Missing"}</span>
                <input value={String(prefs[asset.key as keyof AppPreferences] ?? asset.path ?? "")} onChange={(event) => patchString(asset.key as keyof AppPreferences, event.target.value)} placeholder={asset.filename} />
              </div>)}
            </div>
            <div className="actions">
              <button className="primary" disabled={operationBusy} onClick={() => void onDownloadTrainingFamily(family.id)}>{trainingJob?.family === family.id && (trainingJob.status === "queued" || trainingJob.status === "running") ? "Downloading…" : family.ready && family.support_ready ? `Repair / Verify ${family.name}` : `Download ${family.name} Bundle`}</button>
            </div>
          </section>)}
        </div>

        {trainingJob && <section className="panel stack training-model-progress">
          <div className="preferences-section-heading"><div><div className="card-title">Model download · {activeTrainingFamily?.name ?? trainingJob.family}</div><p className="muted">{trainingJob.phase}</p></div><strong>{trainingProgress ?? 0}%</strong></div>
          <div className="preferences-progress-track"><span style={{ width: `${trainingProgress ?? 0}%` }} /></div>
          <div className="training-model-progress-meta"><span>{trainingJob.current_asset || "Preparing"}</span><span>{formatBytes(trainingJob.bytes_done)}{trainingJob.bytes_total ? ` / ${formatBytes(trainingJob.bytes_total)}` : ""}</span><span>{trainingJob.completed_assets ?? 0} / {trainingJob.total_assets ?? 0} files</span></div>
          {trainingJob.error && <div className="notice error">{trainingJob.error}</div>}
          {(trainingJob.log_tail?.length ?? 0) > 0 && <details><summary>Download log</summary><pre className="preferences-download-log">{trainingJob.log_tail?.join("\n")}</pre></details>}
        </section>}
      </div>}

      {tab === "tracking" && <div className="stack preferences-tab-panel" id="tracking-logging">
        <section className="panel stack">
          <div><p className="eyebrow">Global credentials & defaults</p><div className="card-title">Experiment tracking</div><p className="muted">Keep secrets and account-level defaults here. The Training page chooses the run-name pattern and can later expose deliberate per-run overrides without duplicating credentials.</p></div>
          <div className="grid-2">
            <label>Default logger<select value={prefs.log_with} onChange={(event) => patch("log_with", event.target.value)}><option value="all">Weights & Biases + TensorBoard</option><option value="wandb">Weights & Biases</option><option value="tensorboard">TensorBoard</option><option value="">Disabled</option></select></label>
            <label>W&B project<input value={prefs.wandb_project} onChange={(event) => patch("wandb_project", event.target.value)} placeholder="fizgig" /></label>
            <label>W&B entity <span className="muted">Optional</span><input value={prefs.wandb_entity} onChange={(event) => patch("wandb_entity", event.target.value)} placeholder="team or username; blank uses W&B default" /></label>
            <label>W&B API key <span className="muted">Uses WANDB_API_KEY env when supplied</span><input type="password" autoComplete="off" value={prefs.wandb_api_key} onChange={(event) => patch("wandb_api_key", event.target.value)} placeholder="wandb API key" /></label>
          </div>
          <label>Default W&B run-name pattern<input value={prefs.wandb_run_pattern} onChange={(event) => patch("wandb_run_pattern", event.target.value)} placeholder="{project}-{model}-{run_id}" /><span className="muted">Available run variables: <code>{"{project}"}</code>, <code>{"{model}"}</code>, <code>{"{run_id}"}</code>, <code>{"{run_name}"}</code>, <code>{"{trigger}"}</code>, <code>{"{revision}"}</code>. Training can select a different pattern without changing these account defaults.</span></label>
        </section>
      </div>}

      {tab === "paths" && <div className="stack preferences-tab-panel" id="paths">
        <section className="panel stack">
          <div className="card-title">Persistent model paths</div>
          <label>Caption VLM directory<input value={prefs.caption_model_dir} onChange={(event) => patch("caption_model_dir", event.target.value)} /></label>
          <label>Training model directory<input value={prefs.training_model_dir} onChange={(event) => patch("training_model_dir", event.target.value)} /></label>
          <p className="muted">Projects, sources, caches and model bytes live under the persistent Runpod workspace. Model-specific file overrides are edited on the Models tab.</p>
        </section>
      </div>}

      {tab === "training" && <div className="stack preferences-tab-panel" id="training-defaults">
        <section className="panel stack">
          <div className="card-title">Training defaults</div>
          <p className="muted">Run-sensitive values such as rank, epochs, learning-rate policy and sampling cadence remain visible on Training and are snapshotted per run. As repeated defaults stabilize, they can move here without hiding the effective run configuration.</p>
        </section>
      </div>}

      {tab === "advanced" && <div className="stack preferences-tab-panel" id="advanced">
        <section className="panel stack">
          <div><div className="card-title">Advanced caption VLM defaults</div><p className="muted">Normally leave these blank. They exist for checkpoints whose processor/tokenizer or revision differs from the model source.</p></div>
          <label>Processor / tokenizer override<input value={prefs.qwen_caption_processor} onChange={(event) => patch("qwen_caption_processor", event.target.value)} placeholder="Leave blank to use the same source as the model" /></label>
          <label>Model revision<input value={prefs.qwen_caption_revision} onChange={(event) => patch("qwen_caption_revision", event.target.value)} placeholder="branch, tag, or commit SHA" /></label>
        </section>
      </div>}
    </div>
  );
}