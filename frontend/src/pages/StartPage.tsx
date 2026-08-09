import { useState } from "react";
import { inspectDataset } from "../api";
import { useSession } from "../session";

export function StartPage() {
  const { dataset, setDataset, modelFamily, setModelFamily, triggerWord, setTriggerWord } = useSession();
  const [datasetPath, setDatasetPath] = useState(dataset?.path ?? "/workspace/Fizgig/dataset/sH1VX");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadDataset() {
    setLoading(true);
    setError("");
    try {
      setDataset(await inspectDataset(datasetPath));
    } catch (err) {
      setDataset(null);
      setError(err instanceof Error ? err.message : "Unable to inspect dataset");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="stack">
      <header className="page-header">
        <div><p className="eyebrow">New run</p><h1>Start a New Training Run</h1><p className="muted">Choose the dataset, model family, and output settings.</p></div>
        <div className="actions"><button className="secondary">Open Run Visualizer</button><button className="secondary">Recent Runs</button></div>
      </header>

      <section className="panel stack">
        <div className="card-title">Dataset</div>
        <div className="dataset-picker">
          <label>Dataset folder<input value={datasetPath} onChange={(event) => setDatasetPath(event.target.value)} /></label>
          <button className="secondary" onClick={loadDataset} disabled={loading}>{loading ? "Loading…" : "Load dataset"}</button>
        </div>
        {error && <div className="notice error">{error}</div>}
        {dataset ? (
          <>
            <div className="thumb-grid dataset-preview">
              {dataset.images.slice(0, 8).map((image) => <div className="thumb" key={image.filename}><img src={image.image_url} alt={image.filename} /></div>)}
            </div>
            <div className="dataset-summary">
              <span><strong>{dataset.image_count}</strong> images</span>
              <span><strong>{dataset.caption_count}</strong> captioned</span>
              <span className={dataset.missing_caption_count ? "status-suspect" : "status-good"}><strong>{dataset.missing_caption_count}</strong> missing captions</span>
            </div>
          </>
        ) : <div className="muted">Enter a server-side dataset folder and load it to inspect images and caption sidecars.</div>}
      </section>

      <section className="panel stack">
        <div className="card-title">Model Family</div>
        <div className="grid-3">
          <button className={`model-card ${modelFamily === "krea2" ? "selected" : ""}`} onClick={() => setModelFamily("krea2")}><strong>Krea 2 <span className="badge">Recommended</span></strong><small>Per-image loss intelligence and auto-recaptioning.</small></button>
          <button className={`model-card ${modelFamily === "klein" ? "selected" : ""}`} onClick={() => setModelFamily("klein")}><strong>Klein 9B</strong><small>Fast, flexible, and shares the same core workflow.</small></button>
          <div className="model-card"><strong>More families later</strong><small>The API remains model-agnostic.</small></div>
        </div>
      </section>

      <section className="panel stack">
        <div className="card-title">Training Run</div>
        <div className="form-row"><label>Run name<input defaultValue={`${triggerWord}_${modelFamily}_run_001`} /></label><label>Trigger word<input value={triggerWord} onChange={(event) => setTriggerWord(event.target.value)} /></label></div>
        <label>Output directory<input defaultValue={`/workspace/Fizgig/outputs/${triggerWord}_run_001`} /></label>
        <div className="actions"><button className="primary" disabled={!dataset}>Continue to Image Prep →</button></div>
      </section>
    </div>
  );
}
