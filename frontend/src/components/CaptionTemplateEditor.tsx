import { useEffect, useMemo, useState } from "react";
import {
  getCaptionTemplate,
  previewCaptionTemplate,
  updateCaptionTemplate,
  type CaptionTemplatePayload,
  type CaptionTemplateValidation,
} from "../caption-template-api";

export function CaptionTemplateEditor({ projectId, revisionId, onStateChange }: {
  projectId: string;
  revisionId: string;
  onStateChange?: (value: CaptionTemplatePayload) => void;
}) {
  const [saved, setSaved] = useState<CaptionTemplatePayload | null>(null);
  const [preview, setPreview] = useState<CaptionTemplatePayload | null>(null);
  const [profile, setProfile] = useState("feminine");
  const [templateText, setTemplateText] = useState("");
  const [validation, setValidation] = useState<CaptionTemplateValidation | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [renderedOpen, setRenderedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    setMessage("");
    getCaptionTemplate(projectId, revisionId).then((value) => {
      if (cancelled) return;
      setSaved(value);
      setPreview(value);
      setProfile(value.state.grammar_profile);
      setTemplateText(value.state.template_text);
      setValidation(value.state.validation);
      onStateChange?.(value);
    }).catch((err) => {
      if (!cancelled) setMessage(err instanceof Error ? err.message : "Unable to load caption template");
    });
    return () => { cancelled = true; };
  }, [projectId, revisionId]);

  const dirty = useMemo(() => {
    if (!saved || !validation) return false;
    return profile !== saved.state.grammar_profile
      || templateText !== saved.state.template_text
      || JSON.stringify(validation) !== JSON.stringify(saved.state.validation);
  }, [saved, profile, templateText, validation]);

  useEffect(() => {
    if (!saved || !validation) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      previewCaptionTemplate(projectId, revisionId, {
        grammar_profile: profile,
        template_text: templateText,
        validation,
      }).then((value) => {
        if (!cancelled) setPreview(value);
      }).catch((err) => {
        if (!cancelled) setMessage(err instanceof Error ? err.message : "Template preview failed");
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [projectId, revisionId, saved, profile, templateText, validation]);

  function patchValidation<K extends keyof CaptionTemplateValidation>(key: K, value: CaptionTemplateValidation[K]) {
    setValidation((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!validation || !dirty) return;
    setBusy(true); setMessage("");
    try {
      const value = await updateCaptionTemplate(projectId, revisionId, {
        grammar_profile: profile,
        template_text: templateText,
        validation,
      });
      setSaved(value); setPreview(value);
      setProfile(value.state.grammar_profile);
      setTemplateText(value.state.template_text);
      setValidation(value.state.validation);
      onStateChange?.(value);
      setMessage("Caption template saved to this dataset revision.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save caption template");
    } finally { setBusy(false); }
  }

  async function resetTemplate() {
    setBusy(true); setMessage("");
    try {
      const value = await updateCaptionTemplate(projectId, revisionId, { grammar_profile: profile, reset_template: true });
      setSaved(value); setPreview(value);
      setProfile(value.state.grammar_profile);
      setTemplateText(value.state.template_text);
      setValidation(value.state.validation);
      onStateChange?.(value);
      setMessage("Built-in pose-aware template restored.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to restore caption template");
    } finally { setBusy(false); }
  }

  if (!saved || !preview || !validation) {
    return <section className="panel caption-template-panel"><div className="muted">{message || "Loading caption template…"}</div></section>;
  }

  const vars = preview.variables;
  const profileInfo = preview.grammar_profiles[profile];

  return <section className="panel stack caption-template-panel">
    <div className="caption-template-heading">
      <div>
        <p className="eyebrow">Caption methodology</p>
        <div className="card-title">{saved.state.template_name}</div>
        <p className="muted">Qwen receives the rendered instruction before generation. The trigger is part of the sentence grammar; Fizgig does not append it afterward.</p>
      </div>
      <span className={`caption-template-readiness ${preview.ready ? "ready" : "blocked"}`}>{preview.ready ? "TEMPLATE READY" : "TRIGGER REQUIRED"}</span>
    </div>

    <div className="caption-template-profile-row">
      <label>Subject grammar<select value={profile} onChange={(event) => setProfile(event.target.value)}>{Object.entries(preview.grammar_profiles).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
      <div className="caption-template-binding"><span>Trigger binding</span><strong>{vars.TRIGGER || "Not configured"}</strong><small>{profileInfo ? `${profileInfo.subject_pronoun} / ${profileInfo.object_pronoun} / ${profileInfo.possessive_pronoun}` : profile}</small></div>
      <div className="caption-template-binding"><span>Output contract</span><strong>Trigger = subject</strong><small>exact first token · exactly once · no trailing trigger</small></div>
    </div>

    <div className="caption-template-variable-row">{Object.entries(vars).map(([key, value]) => <span className="caption-template-variable" key={key} title={value}><b>[{key}]</b> {value}</span>)}</div>
    <div className="caption-template-rule-strip"><span>Identity traits suppressed</span><span>Temporary appearance allowed</span><span>Pose geometry prioritized</span><span>Framing explicit</span><span>Background secondary</span><span>Failed binding retries ≤ {validation.max_attempts}</span></div>

    <button className="caption-template-toggle" type="button" onClick={() => setEditorOpen((open) => !open)} aria-expanded={editorOpen}><span><strong>Custom Template</strong><span className="muted"> Edit the reusable VLM instruction and variables</span></span><span>{editorOpen ? "⌃" : "⌄"}</span></button>
    {editorOpen && <div className="caption-template-editor-body stack">
      <textarea className="caption-template-textarea" value={templateText} onChange={(event) => setTemplateText(event.target.value)} spellCheck={false} />
      <div className="caption-template-validation-grid">
        <label className="inline-check"><input type="checkbox" checked={validation.require_trigger_first} onChange={(event) => patchValidation("require_trigger_first", event.target.checked)} /> Require exact trigger first</label>
        <label className="inline-check"><input type="checkbox" checked={validation.require_single_trigger} onChange={(event) => patchValidation("require_single_trigger", event.target.checked)} /> Require one trigger occurrence</label>
        <label className="inline-check"><input type="checkbox" checked={validation.reject_detached_trailing_trigger} onChange={(event) => patchValidation("reject_detached_trailing_trigger", event.target.checked)} /> Reject detached trailing trigger</label>
        <label className="inline-check"><input type="checkbox" checked={validation.retry_on_failure} onChange={(event) => patchValidation("retry_on_failure", event.target.checked)} /> Retry failed structure</label>
        <label>Max attempts<input type="number" min={1} max={5} value={validation.max_attempts} disabled={!validation.retry_on_failure} onChange={(event) => patchValidation("max_attempts", Math.max(1, Math.min(5, Number(event.target.value) || 1)))} /></label>
      </div>
      <div className="actions"><button className="secondary" type="button" onClick={resetTemplate} disabled={busy}>Restore built-in</button><button className="primary" type="button" onClick={save} disabled={busy || !dirty}>{busy ? "Saving…" : "Save Template"}</button></div>
    </div>}

    <button className="caption-template-toggle rendered" type="button" onClick={() => setRenderedOpen((open) => !open)} aria-expanded={renderedOpen}><span><strong>Rendered Instruction</strong><span className="muted"> Exactly what Qwen will receive</span></span><span>{renderedOpen ? "⌃" : "⌄"}</span></button>
    {renderedOpen && <pre className="caption-template-rendered">{preview.rendered_instruction}</pre>}
    {!preview.ready && <div className="notice error">Save a project trigger word above before using template-driven Qwen captioning.</div>}
    {message && <div className={message.toLowerCase().includes("unable") || message.toLowerCase().includes("failed") ? "notice error" : "notice success"}>{message}</div>}
  </section>;
}
