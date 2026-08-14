import { useEffect, useState } from "react";
import { downloadQwenModel, getModelDownload, getPreferences, savePreferences, type Preferences } from "../api";
import { CaptionMethodologySettings } from "../components/CaptionMethodologySettings";

const DEFAULTS: Preferences = {
  qwen_caption_model: "Qwen/Qwen3-VL-8B-Instruct",
  qwen_caption_processor: "",
  qwen_caption_revision: "",
  caption_model_dir: "/workspace/models/captioning",
};

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function PreferencesPage() {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  const [downloadRepo, setDownloadRepo] = useState("Qwen/Qwen3-VL-8B-Instruct");
  const [downloadRevision, setDownloadRevision] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getPreferences().then((value) => {
      setPrefs(value);
      if (!value.qwen_caption_model.startsWith("/")) setDownloadRepo(value.qwen_caption_model);
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load preferences"));
  }, []);

  function patch<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPrefs((current) => ({ ...current, [key]: value }));
  }

  async function onSave() {
    setBusy(true);
    setMessage("");
    try {
      setPrefs(await savePreferences(prefs));
      setMessage("Preferences saved. Any loaded caption model was unloaded so the new selection is used next time.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save preferences");
    } finally {
      setBusy(false);
    }
  }

  async function onDownload() {
    setBusy(true);
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
      const updated = await getPreferences();
      setPrefs(updated);
      setMessage(`Downloaded and selected ${job.repo_id}: ${job.path}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Model download failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <header className="page-header">
        <div><p className="eyebrow">Application</p><h1>Preferences</h1><p className="muted">Configure training models separately from the VLMs used for dataset captioning.</p></div>
        <div className="actions"><button className="primary" onClick={onSave} disabled={busy}>{busy ? "Working…" : "Save Preferences"}</button></div>
      </header>

      <div className="tabs"><span className="tab active">Models</span><span className="tab">Paths</span><span className="tab">AI Providers</span><span className="tab">Training Defaults</span><span className="tab">Advanced</span></div>

      {message && <div className={message.toLowerCase().includes("failed") || message.toLowerCase().includes("unable") ? "notice error" : "notice success"}>{message}</div>}

      <div className="grid-2">
        <section className="panel stack">
          <div>
            <div className="card-title">Caption VLM — Qwen3-VL</div>
            <p className="muted">Independent of Krea 2 or Klein's training text encoder. Use any Transformers-compatible Qwen3-VL model or local checkpoint directory.</p>
          </div>

          <label>Default caption model / checkpoint
            <input value={prefs.qwen_caption_model} onChange={(event) => patch("qwen_caption_model", event.target.value)} placeholder="Qwen/Qwen3-VL-8B-Instruct or /workspace/models/qwen-checkpoint" />
          </label>

          <div className="actions" style={{justifyContent: "flex-start"}}>
            <button className="secondary" type="button" onClick={() => patch("qwen_caption_model", "Qwen/Qwen3-VL-4B-Instruct")}>Use Qwen3-VL 4B Instruct</button>
            <button className="secondary" type="button" onClick={() => patch("qwen_caption_model", "Qwen/Qwen3-VL-8B-Instruct")}>Use Qwen3-VL 8B Instruct</button>
          </div>

          <label>Processor / tokenizer override <span className="muted">Optional</span>
            <input value={prefs.qwen_caption_processor} onChange={(event) => patch("qwen_caption_processor", event.target.value)} placeholder="Leave blank to use the same source as the model" />
          </label>

          <label>Model revision <span className="muted">Optional</span>
            <input value={prefs.qwen_caption_revision} onChange={(event) => patch("qwen_caption_revision", event.target.value)} placeholder="branch, tag, or commit SHA" />
          </label>

          <div className="notice">
            A local checkpoint should be a Hugging Face-compatible model directory containing its config and weight files. If the processor files live elsewhere, set the processor override separately.
          </div>
        </section>

        <section className="panel stack">
          <div>
            <div className="card-title">Download Caption Model</div>
            <p className="muted">Start a background Hub download into workspace storage. The browser polls status, so a large checkpoint does not depend on one long-lived HTTP request.</p>
          </div>
          <label>Hugging Face repository
            <input value={downloadRepo} onChange={(event) => setDownloadRepo(event.target.value)} placeholder="Qwen/Qwen3-VL-8B-Instruct" />
          </label>
          <label>Revision <span className="muted">Optional</span>
            <input value={downloadRevision} onChange={(event) => setDownloadRevision(event.target.value)} placeholder="main" />
          </label>
          <label>Caption model directory
            <input value={prefs.caption_model_dir} onChange={(event) => patch("caption_model_dir", event.target.value)} />
          </label>
          <div className="actions"><button className="primary" onClick={onDownload} disabled={busy || !downloadRepo.trim()}>{busy ? "Working…" : "Download & Select"}</button></div>
          <p className="muted">You can also leave a Hub ID as the default model without downloading it here; Transformers/Hugging Face will use its normal cache.</p>
        </section>
      </div>

      <CaptionMethodologySettings />

      <div className="grid-2">
        <section className="panel stack" id="training-models">
          <div className="card-title">Training Models</div>
          <div className="download-row"><div><strong>Krea 2</strong><small>Training model and its required text encoder are configured independently.</small></div><span className="muted">Coming next</span></div>
          <div className="download-row"><div><strong>Klein</strong><small>Training model and encoder configuration remain independent of captioning.</small></div><span className="muted">Coming next</span></div>
        </section>
        <section className="panel stack">
          <div className="card-title">Caption Provider Behavior</div>
          <p className="muted">The Captions page can override the saved Qwen model, processor, and revision for an individual run without changing these defaults.</p>
          <p className="muted">Built-in Qwen methodologies remain unmodified baselines. Custom 1–3 and the automatic rewrite ladder are configured above and snapshotted into each prepared training run.</p>
        </section>
      </div>
    </div>
  );
}