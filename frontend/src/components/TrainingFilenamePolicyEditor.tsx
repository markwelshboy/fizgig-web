import { useEffect, useMemo, useState } from "react";
import {
  getTrainingFilenames,
  previewTrainingFilenames,
  updateTrainingFilenames,
  type TrainingFilenameScheme,
  type TrainingFilenameState,
} from "../api";

type Props = {
  projectId: string;
  revisionId: string;
  suggestedBasename: string;
  assetVersion: string;
};

function safeBasename(value: string) {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  return cleaned || "training";
}

function schemeLabel(scheme: TrainingFilenameScheme) {
  return scheme === "lineage" ? "Lineage-aware" : "Sequential";
}

export function TrainingFilenamePolicyEditor({ projectId, revisionId, suggestedBasename, assetVersion }: Props) {
  const [state, setState] = useState<TrainingFilenameState | null>(null);
  const [editing, setEditing] = useState(false);
  const [basename, setBasename] = useState(safeBasename(suggestedBasename));
  const [digits, setDigits] = useState(4);
  const [scheme, setScheme] = useState<TrainingFilenameScheme>("lineage");
  const [preview, setPreview] = useState<TrainingFilenameState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getTrainingFilenames(projectId, revisionId)
      .then((next) => {
        if (cancelled) return;
        setState(next);
        if (next.policy.mode === "normalized") {
          setBasename(next.policy.basename);
          setDigits(next.policy.digits);
          setScheme(next.policy.scheme);
        } else {
          setBasename(safeBasename(suggestedBasename));
        }
      })
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : "Unable to load filename policy"));
    return () => { cancelled = true; };
  }, [projectId, revisionId, suggestedBasename, assetVersion]);

  const policySummary = useMemo(() => {
    if (!state || state.policy.mode === "original") return "Original project filenames";
    const hashes = "#".repeat(Math.min(8, state.policy.digits));
    return `${state.policy.basename}_${hashes}.png · ${schemeLabel(state.policy.scheme)}`;
  }, [state]);

  function beginConfigure() {
    if (state?.policy.mode === "normalized") {
      setBasename(state.policy.basename);
      setDigits(state.policy.digits);
      setScheme(state.policy.scheme);
    } else {
      setBasename(safeBasename(suggestedBasename));
      setDigits(4);
      setScheme("lineage");
    }
    setPreview(null);
    setError("");
    setEditing(true);
  }

  async function buildPreview() {
    setBusy(true);
    setError("");
    try {
      setPreview(await previewTrainingFilenames(projectId, revisionId, { basename, digits, scheme }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to preview filenames");
    } finally {
      setBusy(false);
    }
  }

  async function saveNormalized() {
    setBusy(true);
    setError("");
    try {
      const next = await updateTrainingFilenames(projectId, revisionId, {
        mode: "normalized",
        basename,
        digits,
        scheme,
        rebuild: true,
      });
      setState(next);
      setPreview(null);
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save filename policy");
    } finally {
      setBusy(false);
    }
  }

  async function useOriginalNames() {
    setBusy(true);
    setError("");
    try {
      const next = await updateTrainingFilenames(projectId, revisionId, {
        mode: "original",
        basename: "",
        digits: state?.policy.digits ?? 4,
        scheme: state?.policy.scheme ?? "lineage",
        rebuild: true,
      });
      setState(next);
      setPreview(null);
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to restore original filenames");
    } finally {
      setBusy(false);
    }
  }

  async function rebuildNumbering() {
    if (!state || state.policy.mode !== "normalized") return;
    if (!window.confirm("Rebuild the current training filename numbering? Existing project filenames and provenance are unchanged, but future run filenames may differ from earlier runs.")) return;
    setBusy(true);
    setError("");
    try {
      const next = await updateTrainingFilenames(projectId, revisionId, {
        mode: "normalized",
        basename: state.policy.basename,
        digits: state.policy.digits,
        scheme: state.policy.scheme,
        rebuild: true,
      });
      setState(next);
      setPreview(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to rebuild numbering");
    } finally {
      setBusy(false);
    }
  }

  const visibleRows = (preview ?? state)?.rows ?? [];

  return <div className="training-filename-policy">
    <div className="training-filename-policy-head">
      <div>
        <p className="eyebrow">Run-local naming</p>
        <div className="card-title">Training Filenames</div>
        <p className="muted">Rationalize the trainer/export copy without renaming project assets or breaking caption and derivative provenance.</p>
      </div>
      <div className="training-filename-policy-status">
        <strong>{policySummary}</strong>
        <div className="actions">
          <button className="secondary" type="button" disabled={busy} onClick={beginConfigure}>Configure…</button>
          {state?.policy.mode === "normalized" && <button className="secondary" type="button" disabled={busy} onClick={rebuildNumbering}>Rebuild numbering</button>}
        </div>
      </div>
    </div>

    {state?.policy.mode === "normalized" && !editing && visibleRows.length > 0 && <div className="training-filename-samples">
      {visibleRows.slice(0, 4).map((row) => <div key={row.asset_id || row.project_filename}><span>{row.project_filename}</span><b>→</b><strong>{row.training_filename}</strong></div>)}
      {visibleRows.length > 4 && <small>+ {visibleRows.length - 4} more mapped training assets</small>}
    </div>}

    {editing && <div className="training-filename-editor">
      <div className="form-row training-filename-fields">
        <label>Basename<input value={basename} onChange={(event) => { setBasename(event.target.value); setPreview(null); }} placeholder="sH1VX" /></label>
        <label>Digits<select value={digits} onChange={(event) => { setDigits(Number(event.target.value)); setPreview(null); }}>{[2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Scheme<select value={scheme} onChange={(event) => { setScheme(event.target.value as TrainingFilenameScheme); setPreview(null); }}><option value="lineage">Lineage-aware</option><option value="sequential">Sequential</option></select></label>
      </div>
      <p className="muted training-filename-hint">Lineage-aware keeps source families recognizable: <code>{safeBasename(basename)}_0000.png</code>, <code>{safeBasename(basename)}_0000_face01.png</code>, <code>{safeBasename(basename)}_0000_crop01.png</code>. Sequential simply numbers the final working set. Normalized run images are written as PNG.</p>
      <div className="actions">
        <button className="secondary" type="button" disabled={busy} onClick={buildPreview}>Preview mapping</button>
        <button className="primary" type="button" disabled={busy} onClick={saveNormalized}>Save filename policy</button>
        {state?.policy.mode === "normalized" && <button className="secondary" type="button" disabled={busy} onClick={useOriginalNames}>Use original names</button>}
        <button className="secondary" type="button" disabled={busy} onClick={() => { setEditing(false); setPreview(null); setError(""); }}>Cancel</button>
      </div>

      {preview && <div className="training-filename-preview">
        <div className="card-title">Preview</div>
        <div className="training-filename-map">
          {preview.rows.slice(0, 12).map((row) => <div key={row.asset_id || row.project_filename}><span title={row.project_filename}>{row.project_filename}</span><b>→</b><strong title={row.training_filename}>{row.training_filename}</strong></div>)}
        </div>
        {preview.rows.length > 12 && <small className="muted">Showing 12 of {preview.rows.length} mappings.</small>}
      </div>}
    </div>}

    {error && <div className="notice status-suspect">{error}</div>}
  </div>;
}
