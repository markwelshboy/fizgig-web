export function PreferencesPage() {
  return (
    <div className="stack">
      <header className="page-header"><div><p className="eyebrow">Application</p><h1>Preferences</h1><p className="muted">Configure models, paths, AI providers, and training defaults.</p></div><div className="actions"><button className="primary">Save Preferences</button></div></header>
      <div className="tabs"><span className="tab active">Models</span><span className="tab">Paths</span><span className="tab">AI Providers</span><span className="tab">Training Defaults</span><span className="tab">Advanced</span></div>
      <div className="grid-2">
        <section className="panel stack">
          <div className="card-title">Model Downloads</div>
          {[['Krea 2 RAW','Required for Krea 2 training','23.8 GB',true],['Krea 2 Turbo','Fast preview model','15.2 GB',true],['Klein 9B Base','Required for Klein training','18.7 GB',true],['Klein 9B Distilled','Fast preview / extraction model','12.4 GB',false],['Qwen3-VL Text Encoder','Krea 2 text / vision encoder','8.2 GB',true]].map(([name,desc,size,ok])=>(
            <div className="download-row" key={String(name)}>
              <div><strong>{name}</strong><small>{desc}</small></div><span className={ok?'status-good':'muted'}>{ok?'Downloaded':'Missing'}</span><button className={ok?'secondary':'primary'}>{ok?'Verify':'Download'}</button>
            </div>
          ))}
          <label>Model cache location<input defaultValue="/workspace/Fizgig/models" /></label>
        </section>
        <div className="stack">
          <section className="panel stack">
            <div className="card-title">Storage Overview</div>
            <div className="metric-grid">
              <div className="metric"><span>Total Disk</span><strong>250 GB</strong></div>
              <div className="metric"><span>Used</span><strong>111.6 GB</strong></div>
              <div className="metric"><span>Models</span><strong>78.2 GB</strong></div>
              <div className="metric"><span>Cache</span><strong>5.4 GB</strong></div>
            </div>
            <div className="progress"><i style={{width:'44%'}} /></div>
            <div className="actions"><button className="secondary">Clear Cache</button></div>
          </section>
          <section className="panel stack">
            <div className="card-title">Application</div>
            <label>Theme<select defaultValue="dark"><option value="dark">Dark</option><option value="system">System</option></select></label>
            <label>Language<select defaultValue="en"><option value="en">English</option></select></label>
            <label><input type="checkbox" defaultChecked /> Auto-check for updates</label>
          </section>
        </div>
      </div>
    </div>
  );
}
