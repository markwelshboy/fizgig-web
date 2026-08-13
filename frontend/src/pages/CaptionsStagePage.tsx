import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getProjectRevisionPolicy, type ProjectRevisionPolicy } from "../api";
import { getCaptionStatus, type CaptionStatusState } from "../caption-runtime-api";
import { useSession } from "../session";
import { CaptionsPage } from "./CaptionsPage";

export function CaptionsStagePage() {
  const navigate = useNavigate();
  const { project, revision } = useSession();
  const [statuses, setStatuses] = useState<CaptionStatusState | null>(null);
  const [policy, setPolicy] = useState<ProjectRevisionPolicy | null>(null);

  const revisionVersion = revision?.assets
    .map((asset) => `${asset.filename}:${asset.included === false ? 0 : 1}:${asset.caption_sha256 ?? ""}`)
    .join("|") ?? "";

  useEffect(() => {
    if (!project || !revision) {
      setStatuses(null);
      setPolicy(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      getCaptionStatus(project.id, revision.id),
      getProjectRevisionPolicy(project.id, revision.id),
    ]).then(([nextStatuses, nextPolicy]) => {
      if (!cancelled) {
        setStatuses(nextStatuses);
        setPolicy(nextPolicy);
      }
    }).catch(() => {
      if (!cancelled) {
        setStatuses(null);
        setPolicy(null);
      }
    });
    return () => { cancelled = true; };
  }, [project?.id, revision?.id, revisionVersion]);

  const summary = useMemo(() => {
    const assets = (revision?.assets ?? []).filter((asset) => asset.included !== false);
    const total = assets.length;
    let saved = 0;
    let missingTrigger = 0;
    let spelling = 0;
    let protectedCount = 0;
    let alwaysTrain = 0;
    let held = 0;
    let locked = 0;

    for (const asset of assets) {
      const status = statuses?.statuses[asset.filename];
      if (asset.caption.trim()) saved += 1;
      if (status?.trigger_state === "missing" || status?.trigger_state === "case_mismatch") missingTrigger += 1;
      if ((status?.spelling_issue_count ?? 0) > 0) spelling += 1;
      if ((status?.protected_matches.length ?? 0) > 0) protectedCount += 1;
      const itemPolicy = policy?.assets[asset.filename];
      if (itemPolicy?.training_policy === "always_train") alwaysTrain += 1;
      if (itemPolicy?.auto_recaption_policy === "hold") held += 1;
      if (itemPolicy?.auto_recaption_policy === "never") locked += 1;
    }

    const triggerConfigured = Boolean((statuses?.trigger_word ?? project?.trigger_word ?? "").trim());
    return { total, saved, missing: total - saved, triggerConfigured, missingTrigger, spelling, protectedCount, alwaysTrain, held, locked };
  }, [project?.trigger_word, revisionVersion, statuses, policy]);

  return <div className="caption-stage-shell">
    <CaptionsPage />
    <section className="panel caption-stage-footer">
      <div className="caption-status-legend" aria-label="Caption status legend">
        <div className="caption-legend-row">
          <span className="caption-legend-title">Caption Status</span>
          <span><i className="caption-status-dot missing" /> Missing caption</span>
          <span><i className="caption-status-glyph ai">AI</i> AI caption</span>
          <span><i className="caption-status-glyph manual">✎</i> Manual edit</span>
          <span><i className="caption-status-glyph saved">S</i> Saved / source caption</span>
          <span><i className="caption-status-glyph trigger">T!</i> Trigger missing / changed case</span>
          <span><i className="caption-status-glyph protected">P</i> Protected phrase</span>
          <span><i className="caption-status-glyph spelling">!</i> Spelling review</span>
          <span><i className="caption-status-glyph unknown">?</i> Status unavailable</span>
        </div>
        <div className="caption-legend-row">
          <span className="caption-legend-title">Training Intervention</span>
          <span><i className="caption-status-chip">Train</i> Always Train</span>
          <span><i className="caption-status-chip">Hold</i> Auto-recaption held</span>
          <span><i className="caption-status-chip">Lock</i> Auto-recaption disabled</span>
        </div>
      </div>

      <div className="caption-stage-summary">
        <div className="caption-summary-heading">Captioning Summary</div>
        <div className="caption-summary-items">
          <span><strong>{summary.saved}</strong> / {summary.total} captions saved</span>
          {summary.missing > 0 && <span className="warning"><strong>{summary.missing}</strong> missing caption{summary.missing === 1 ? "" : "s"}</span>}
          {!summary.triggerConfigured
            ? <span className="warning"><strong>No trigger word configured</strong>{summary.saved ? ` · ${summary.saved} saved caption${summary.saved === 1 ? "" : "s"} cannot be checked for trigger presence` : ""}</span>
            : summary.missingTrigger > 0 && <span className="warning"><strong>{summary.missingTrigger}</strong> trigger warning{summary.missingTrigger === 1 ? "" : "s"}</span>}
          {summary.spelling > 0 && <span className="warning"><strong>{summary.spelling}</strong> image{summary.spelling === 1 ? "" : "s"} with possible spelling issues</span>}
          {summary.protectedCount > 0 && <span className="warning"><strong>{summary.protectedCount}</strong> image{summary.protectedCount === 1 ? "" : "s"} with protected phrases</span>}
          {summary.alwaysTrain > 0 && <span><strong>{summary.alwaysTrain}</strong> Always Train</span>}
          {summary.held > 0 && <span><strong>{summary.held}</strong> auto-recaption held</span>}
          {summary.locked > 0 && <span><strong>{summary.locked}</strong> auto-recaption disabled</span>}
        </div>
      </div>

      <div className="actions caption-stage-proceed">
        <button className="primary" onClick={() => navigate("/samples")}>Proceed to <strong>Sampling</strong> →</button>
      </div>
    </section>
  </div>;
}
