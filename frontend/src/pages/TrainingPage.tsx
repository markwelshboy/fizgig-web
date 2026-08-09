export function TrainingPage() {
  return (
    <div className="stack">
      <header className="page-header"><div><p className="eyebrow">Active run</p><h1>Training</h1><p className="muted">Monitor progress, view loss intelligence, samples, and checkpoints.</p></div><div className="actions"><button className="secondary">Open Run Visualizer</button><button className="danger">Stop Training</button></div></header>

      <section className="panel stack">
        <div className="page-header"><div><div className="card-title">Epoch 7 / 20</div><div className="progress"><i /></div></div><div className="muted">35% complete</div></div>
        <div className="metric-grid">
          <div className="metric"><span>Elapsed</span><strong>02:14:38</strong></div>
          <div className="metric"><span>ETA</span><strong>04:12:06</strong></div>
          <div className="metric"><span>Steps</span><strong>3,456 / 9,800</strong></div>
          <div className="metric"><span>Images</span><strong>128</strong></div>
        </div>
      </section>

      <div className="tabs"><span className="tab active">Overview</span><span className="tab">Per-image Loss</span><span className="tab">Logs</span><span className="tab">Samples</span><span className="tab">Checkpoints</span></div>

      <div className="grid-2">
        <section className="panel stack">
          <div className="card-title">Loss Overview</div>
          <div className="fake-chart">
            <svg viewBox="0 0 600 220" preserveAspectRatio="none" aria-label="Example loss chart">
              <polyline fill="none" stroke="#8b5cf6" strokeWidth="3" points="0,60 70,42 140,88 210,75 280,122 350,130 420,110 490,145 560,132 600,136" />
              <polyline fill="none" stroke="#c084fc" strokeWidth="2" opacity=".8" points="0,82 70,73 140,95 210,102 280,115 350,108 420,125 490,123 560,137 600,132" />
            </svg>
          </div>
        </section>
        <section className="panel stack">
          <div className="card-title">Per-image Status</div>
          <div className="metric-grid">
            <div className="metric"><span className="status-stuck">Stuck</span><strong>5</strong></div>
            <div className="metric"><span className="status-suspect">Suspect</span><strong>8</strong></div>
            <div className="metric"><span className="status-learning">Learning</span><strong>23</strong></div>
            <div className="metric"><span className="status-good">Good</span><strong>92</strong></div>
          </div>
        </section>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="card-title">Recent Problem Images</div>
          <table className="table"><thead><tr><th>Image</th><th>Status</th><th>EMA Loss</th><th>LR Mult</th></tr></thead><tbody>
            <tr><td>referenceimage_00012.png</td><td className="status-stuck">STUCK</td><td>0.184</td><td>0.50×</td></tr>
            <tr><td>referenceimage_00026.png</td><td className="status-suspect">SUSPECT</td><td>0.161</td><td>0.70×</td></tr>
            <tr><td>referenceimage_00105.png</td><td className="status-learning">LEARNING</td><td>0.153</td><td>1.00×</td></tr>
          </tbody></table>
        </section>
        <section className="panel stack">
          <div className="card-title">Training Controls</div>
          <div className="actions" style={{justifyContent:"flex-start"}}><button className="secondary">Pause</button><button className="secondary">Save Checkpoint</button></div>
          <label><input type="checkbox" defaultChecked /> Log per-image loss</label>
          <label><input type="checkbox" defaultChecked /> Per-image LR</label>
          <label><input type="checkbox" defaultChecked /> Auto-recaption</label>
          <label><input type="checkbox" defaultChecked /> Warm-up look outliers</label>
        </section>
      </div>
    </div>
  );
}
