export function SamplesPage() {
  return (
    <div className="stack">
      <header className="page-header"><div><p className="eyebrow">Preview generation</p><h1>Samples</h1><p className="muted">Configure how preview images are generated during training.</p></div></header>
      <div className="grid-2">
        <section className="panel stack">
          <label>Base prompt<textarea defaultValue="portrait photo of sH1VX woman, cinematic lighting, highly detailed" /></label>
          <label>Negative prompt<textarea defaultValue="text, watermark, blurry, low quality, bad anatomy" /></label>
          <div className="form-row"><label>Sampler<select><option>DPM++ 2M Karras</option></select></label><label>Steps<input type="number" defaultValue={30} /></label></div>
          <div className="form-row"><label>CFG scale<input type="number" step="0.1" defaultValue={5.0} /></label><label>Seed<input type="number" defaultValue={-1} /></label></div>
          <div className="form-row"><label>Width<input type="number" defaultValue={1024} /></label><label>Height<input type="number" defaultValue={1365} /></label></div>
          <label>Samples per prompt<input type="number" defaultValue={4} /></label>
          <section className="model-card"><strong>Reference image</strong><small>referenceimage_00042.png</small></section>
          <div className="actions"><button className="primary">Continue to Training →</button></div>
        </section>
        <section className="panel stack">
          <div className="card-title">Sample Preview</div>
          <div className="preview-grid">{Array.from({length:4}).map((_,i)=><div className="preview" key={i} />)}</div>
          <p className="muted">Preview generation will use the current model-family settings.</p>
          <button className="primary">Generate Preview</button>
        </section>
      </div>
    </div>
  );
}
