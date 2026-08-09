export function CaptionsPage() {
  return (
    <div className="stack">
      <header className="page-header"><div><p className="eyebrow">Dataset</p><h1>Captions</h1><p className="muted">Review, edit, and generate captions for the current dataset.</p></div><div className="actions"><button className="primary">Generate Missing</button><button className="secondary">Bulk Actions</button></div></header>
      <div className="caption-layout">
        <section className="panel">
          <div className="toolbar"><input placeholder="Search captions…" /><select defaultValue="filename"><option value="filename">Sort: Filename</option><option value="missing">Missing first</option></select></div>
          <div className="thumb-grid">{Array.from({length:16}).map((_,i)=><div className={`thumb ${i===5?"selected":""}`} key={i} />)}</div>
        </section>
        <section className="panel stack">
          <div><div className="card-title">referenceimage_00042.png</div><div className="muted">42 / 128</div></div>
          <label>Caption<textarea defaultValue="sH1VX woman, blonde hair, standing by a window, natural light, black dress" /></label>
          <label>Trigger word<input defaultValue="sH1VX" /></label>
          <div className="actions"><button className="secondary">Regenerate with AI</button><button className="primary">Save Caption</button></div>
          <div className="card-title">AI Captioning</div>
          <label>Provider<select defaultValue="qwen"><option value="qwen">Qwen3-VL 8B Instruct</option><option value="joy">JoyCaption</option></select></label>
          <label><input type="checkbox" defaultChecked /> Add trigger word automatically</label>
        </section>
      </div>
    </div>
  );
}
