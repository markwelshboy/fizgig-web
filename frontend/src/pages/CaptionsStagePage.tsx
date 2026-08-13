import { useNavigate } from "react-router-dom";
import { CaptionsPage } from "./CaptionsPage";

export function CaptionsStagePage() {
  const navigate = useNavigate();
  return <div className="caption-stage-shell">
    <CaptionsPage />
    <section className="panel caption-stage-footer">
      <div className="caption-status-legend" aria-label="Caption status legend">
        <span className="caption-legend-title">Legend</span>
        <span><i className="caption-status-dot missing" /> Missing caption</span>
        <span><i className="caption-status-glyph ai">AI</i> AI caption</span>
        <span><i className="caption-status-glyph manual">✎</i> Manual edit</span>
        <span><i className="caption-status-glyph saved">S</i> Saved / source caption</span>
        <span><i className="caption-status-glyph trigger">T!</i> Trigger missing / changed case</span>
        <span><i className="caption-status-glyph protected">P</i> Protected phrase</span>
        <span><i className="caption-status-glyph spelling">!</i> Spelling review</span>
        <span><i className="caption-status-glyph unknown">?</i> Status unavailable</span>
        <span><i className="caption-status-chip">Train</i> Always Train</span>
        <span><i className="caption-status-chip">Hold</i> Auto-recaption held</span>
        <span><i className="caption-status-chip">Lock</i> Auto-recaption disabled</span>
      </div>
      <div className="actions caption-stage-proceed">
        <button className="primary" onClick={() => navigate("/samples")}>Proceed to <strong>Sampling</strong> →</button>
      </div>
    </section>
  </div>;
}
