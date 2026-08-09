import { useState } from "react";

export function StartPage() {
  const [family, setFamily] = useState("krea2");
  return (
    <div className="stack">
      <header className="page-header">
        <div><p className="eyebrow">New run</p><h1>Start a New Training Run</h1><p className="muted">Choose the dataset, model family, and output settings.</p></div>
        <div className="actions"><button className="secondary">Open Run Visualizer</button><button className="secondary">Recent Runs</button></div>
      </header>

      <section className="panel stack">
        <div className="card-title">Dataset</div>
        <label>Dataset folder<input defaultValue="/workspace/Fizgig/dataset/sH1VX" /></label>
        <div className="thumb-grid">{Array.from({length:8}).map((_,i)=><div className="thumb" key={i} />)}</div>
        <div className="muted">128 images · captions found for all images</div>
      </section>

      <section className="panel stack">
        <div className="card-title">Model Family</div>
        <div className="grid-3">
          <button className={`model-card ${family==="krea2"?"selected":""}`} onClick={()=>setFamily("krea2")}><strong>Krea 2 <span className="badge">Recommended</span></strong><small>Per-image loss intelligence and auto-recaptioning.</small></button>
          <button className={`model-card ${family==="klein"?"selected":""}`} onClick={()=>setFamily("klein")}><strong>Klein 9B</strong><small>Fast, flexible, and shares the same core workflow.</small></button>
          <div className="model-card"><strong>More families later</strong><small>API remains model-agnostic.</small></div>
        </div>
      </section>

      <section className="panel stack">
        <div className="card-title">Training Run</div>
        <div className="form-row"><label>Run name<input defaultValue="sH1VX_krea2_run_001" /></label><label>Trigger word<input defaultValue="sH1VX" /></label></div>
        <label>Output directory<input defaultValue="/workspace/Fizgig/outputs/sH1VX_run_001" /></label>
        <div className="actions"><button className="primary">Continue to Image Prep →</button></div>
      </section>
    </div>
  );
}
