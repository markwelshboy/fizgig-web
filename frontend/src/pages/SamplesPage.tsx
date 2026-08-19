import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TriggerTemplateText } from "../TriggerText";
import {
  getSamplingPlan,
  updateSamplingPlan,
  type SampleDefinition,
  type SamplingPlan,
} from "../sampling-api";
import { useSession } from "../session";

const PROMPT_LIBRARY = [
  { name: "Coffee shop", template: "A photo of __trigger__ woman sitting in a coffee shop with a large cup of coffee in her hands." },
  { name: "Outdoor walk", template: "A photo of __trigger__ woman walking outdoors on a city street, natural candid pose, full body visible." },
  { name: "Window portrait", template: "A portrait of __trigger__ woman seated beside a large window, soft natural daylight, looking toward the camera." },
  { name: "Evening restaurant", template: "A photo of __trigger__ woman seated at a restaurant table in the evening, warm ambient lighting, relaxed expression." },
  { name: "Studio close-up", template: "A close-up portrait of __trigger__ woman against a simple studio background, direct eye contact, soft directional light." },
] as const;

function nextSampleId(samples: SampleDefinition[]) {
  const max = samples.reduce((value, sample) => {
    const match = /^sample-(\d+)$/.exec(sample.id);
    return Math.max(value, match ? Number(match[1]) : 0);
  }, 0);
  return `sample-${String(max + 1).padStart(4, "0")}`;
}

function configuredCfg(sample: SampleDefinition) {
  return sample.configured_cfg_scale ?? sample.cfg_scale ?? 1.0;
}

function configuredSeed(sample: SampleDefinition) {
  return sample.configured_seed ?? sample.seed ?? 42;
}

export function SamplesPage() {
  const navigate = useNavigate();
  const { project, triggerWord } = useSession();
  const [plan, setPlan] = useState<SamplingPlan | null>(null);
  const [savedPlan, setSavedPlan] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [libraryIndex, setLibraryIndex] = useState(0);
  const [editId, setEditId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>(PROMPT_LIBRARY[0].template);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [cfgScale, setCfgScale] = useState(1.0);
  const [editSeed, setEditSeed] = useState(42);

  useEffect(() => {
    if (!project) { setPlan(null); setSavedPlan(""); return; }
    setLoading(true); setMessage("");
    getSamplingPlan(project.id).then((result) => {
      setPlan(result);
      setSavedPlan(JSON.stringify(result));
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load sampling plan"))
      .finally(() => setLoading(false));
  }, [project?.id]);

  const dirty = Boolean(plan && JSON.stringify(plan) !== savedPlan);
  const resolvedTrigger = project?.trigger_word?.trim() || triggerWord.trim();
  const sampleCount = plan?.samples.length ?? 0;
  const turbo = Boolean(plan?.renderer.use_distilled);
  const configuredSteps = plan?.renderer.configured_steps ?? plan?.renderer.steps ?? 8;
  const configuredFlowShift = plan?.renderer.configured_flow_shift ?? plan?.renderer.flow_shift ?? null;

  async function persist(next: SamplingPlan, success: string) {
    if (!project) return;
    setSaving(true); setMessage("");
    try {
      const saved = await updateSamplingPlan(project.id, next);
      setPlan(saved);
      setSavedPlan(JSON.stringify(saved));
      setMessage(success);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save sampling plan");
      throw err;
    } finally {
      setSaving(false);
    }
  }

  function patchPlan(patch: Partial<SamplingPlan>) {
    setPlan((current) => current ? { ...current, ...patch } : current);
  }

  async function toggleSampling(enabled: boolean) {
    if (!plan) return;
    await persist({ ...plan, enabled }, enabled ? "Sampling enabled." : "Sampling disabled; saved settings are retained.");
  }

  function setTurboSampling(enabled: boolean) {
    setPlan((current) => current ? {
      ...current,
      renderer: { ...current.renderer, use_distilled: enabled },
    } : current);
  }

  function resetEditor(keepShape = true) {
    setEditId(null);
    setPrompt(PROMPT_LIBRARY[libraryIndex].template);
    if (!keepShape) { setWidth(1024); setHeight(1024); }
    setCfgScale(1.0);
    setEditSeed(42);
  }

  function chooseLibraryPrompt(index: number) {
    setLibraryIndex(index);
    setPrompt(PROMPT_LIBRARY[index].template);
    setEditId(null);
    setCfgScale(1.0);
    setEditSeed(42);
  }

  async function saveSample() {
    if (!plan || !project || !prompt.trim()) return;
    const configuredCfgScale = Math.max(0, Number(cfgScale));
    const explicitSeed = Math.max(0, Math.min(4294967295, Math.round(editSeed)));
    const definition: SampleDefinition = {
      id: editId ?? nextSampleId(plan.samples),
      prompt_template: prompt.trim(),
      width: Math.max(128, Math.round(width)),
      height: Math.max(128, Math.round(height)),
      cfg_scale: turbo ? 1.0 : configuredCfgScale,
      configured_cfg_scale: configuredCfgScale,
      seed: explicitSeed,
      configured_seed: explicitSeed,
    };

    const samples = editId
      ? plan.samples.map((sample) => sample.id === editId ? definition : sample)
      : [...plan.samples, definition];
    const next = { ...plan, samples };
    await persist(next, editId ? `${definition.id} updated.` : `${definition.id} added to the sampling set.`);
    resetEditor();
  }

  function beginEdit(sample: SampleDefinition) {
    setEditId(sample.id);
    setPrompt(sample.prompt_template);
    setWidth(sample.width);
    setHeight(sample.height);
    setCfgScale(configuredCfg(sample));
    setEditSeed(configuredSeed(sample));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function duplicateSample(sample: SampleDefinition) {
    if (!plan) return;
    const copy: SampleDefinition = {
      ...sample,
      id: nextSampleId(plan.samples),
      cfg_scale: turbo ? 1.0 : configuredCfg(sample),
      configured_cfg_scale: configuredCfg(sample),
      seed: configuredSeed(sample),
      configured_seed: configuredSeed(sample),
    };
    const next = { ...plan, samples: [...plan.samples, copy] };
    await persist(next, `${copy.id} duplicated from ${sample.id}.`);
    beginEdit(copy);
  }

  async function deleteSample(sample: SampleDefinition) {
    if (!plan || !window.confirm(`Delete ${sample.id}?`)) return;
    const next = { ...plan, samples: plan.samples.filter((item) => item.id !== sample.id) };
    await persist(next, `${sample.id} deleted.`);
    if (editId === sample.id) resetEditor();
  }

  async function saveSettings() {
    if (!plan || !dirty) return;
    await persist(plan, "Sampling settings saved to the project.");
  }

  const sampleRows = useMemo(() => plan?.samples ?? [], [plan]);

  if (!project) return <section className="panel hero-panel stack"><p className="eyebrow">Project required</p><h1>Sampling</h1><p className="muted">Open a project before configuring training samples.</p></section>;
  if (loading || !plan) return <section className="panel"><p className="muted">Loading sampling plan…</p>{message && <div className="notice error">{message}</div>}</section>;

  return <div className="stack sampling-page">
    <header className="page-header"><div><p className="eyebrow">Evaluation probes</p><h1>Sampling</h1><p className="muted">Build stable evaluation probes for training. Choose whether to sample, how Fizgig should render, when to render, and finally what prompts / seeds to evaluate.</p></div></header>

    <div className="sampling-master-row">
      <label className="sampling-master-toggle inline-check"><input type="checkbox" checked={plan.enabled} disabled={saving} onChange={(event) => void toggleSampling(event.target.checked)} /> Enable Sampling</label>
      <button className="secondary" onClick={() => void saveSettings()} disabled={saving || !dirty}>{saving ? "Saving…" : "Save Sampling Settings"}</button>
    </div>

    <fieldset className={`sampling-page-config ${plan.enabled ? "" : "disabled"}`} disabled={!plan.enabled}>
      <section className="panel stack sampling-engine-panel">
        <div><p className="eyebrow">Sampling engine</p><div className="card-title">How to sample</div><p className="muted">Renderer-level settings apply to the whole probe set. Turbo mode uses Fizgig's fast in-training Krea preview path while preserving any non-Turbo values you configure.</p></div>
        <div className="sample-settings-grid">
          <label className="inline-check"><input type="checkbox" checked={turbo} onChange={(event) => setTurboSampling(event.target.checked)} /> Use distilled / Turbo model for samples</label>
          <label>Cache sample model<select value={plan.renderer.cache_model} onChange={(event) => patchPlan({ renderer: { ...plan.renderer, cache_model: event.target.value as SamplingPlan["renderer"]["cache_model"] } })}><option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option></select></label>
          <div className="sampling-effective-pair">
            <label>{turbo ? "Configured steps" : "Steps"}<input type="number" min={1} max={500} value={configuredSteps} disabled={turbo} onChange={(event) => patchPlan({ renderer: { ...plan.renderer, configured_steps: Number(event.target.value) } })} /></label>
            {turbo && <label className="sampling-effective-field">Effective steps<input type="number" value={8} readOnly /></label>}
          </div>
          <div className="sampling-effective-pair">
            <label><span className="sample-field-label-inline">{turbo ? "Configured Flow Shift" : "Flow Shift"} <small>Optional</small></span><input type="number" min={0} step={0.1} value={configuredFlowShift ?? ""} disabled={turbo} placeholder="Model default" onChange={(event) => patchPlan({ renderer: { ...plan.renderer, configured_flow_shift: event.target.value === "" ? null : Number(event.target.value) } })} /></label>
            {turbo && <label className="sampling-effective-field">Effective Flow Shift<input value="Model default" readOnly /></label>}
          </div>
        </div>
        <label>Negative prompt<textarea value={plan.renderer.negative_prompt} disabled={turbo} onChange={(event) => patchPlan({ renderer: { ...plan.renderer, negative_prompt: event.target.value } })} /><span className="muted">{turbo ? "Saved but inactive while Turbo is CFG-free." : "Used when the renderer enables CFG."}</span></label>
        {turbo
          ? <div className="sample-distilled-note">Fast Fizgig preview contract: Turbo path, 8 effective steps, CFG 1.0 / CFG-free and model-default Flow Shift. Your configured non-Turbo values remain stored and reappear unchanged if Turbo is turned off.</div>
          : <div className="notice warning">Non-Turbo values are preserved and editable, but the current Krea in-training preview launcher still requires the Fizgig Turbo path. Starting a run with sampling enabled in this mode will be blocked until the non-Turbo renderer is implemented.</div>}
      </section>

      <section className="panel stack sampling-base-panel">
        <div className="sample-section-heading sampling-base-heading">
          <div><p className="eyebrow">Base cadence</p><div className="card-title">When to sample</div><p className="muted">This cadence is shared by the sample set. Generated preview images are preserved inside the training run for later review.</p></div>
        </div>
        <div className="sampling-base-controls">
          <label className="inline-check sampling-start-check"><input type="checkbox" checked={plan.schedule.sample_at_start} onChange={(event) => patchPlan({ schedule: { ...plan.schedule, sample_at_start: event.target.checked } })} /> Sample at start</label>
          <label>Every N epochs<input type="number" min={0} value={plan.schedule.every_n_epochs} onChange={(event) => patchPlan({ schedule: { ...plan.schedule, every_n_epochs: Number(event.target.value) } })} /><span className="muted">0 disables epoch cadence.</span></label>
          <label>Every N steps<input type="number" min={0} value={plan.schedule.every_n_steps} onChange={(event) => patchPlan({ schedule: { ...plan.schedule, every_n_steps: Number(event.target.value) } })} /><span className="muted">0 disables step cadence. Current Krea in-training previews run at epoch boundaries.</span></label>
        </div>
      </section>

      <section className="panel stack sample-editor-panel">
        <div className="sample-section-heading"><div><p className="eyebrow">{editId ? "Edit sample" : "New sample"}</p><div className="card-title">{editId ?? "What to sample"}</div><p className="muted">Each probe keeps its own prompt, dimensions and explicit seed. Turbo temporarily overrides CFG to 1.0 without discarding the value you configured.</p></div>{editId && <button className="secondary" onClick={() => resetEditor()}>Cancel edit</button>}</div>

        <div className="sample-library-row">
          <label>Prompt Library<select value={libraryIndex} title={PROMPT_LIBRARY[libraryIndex].template} onChange={(event) => chooseLibraryPrompt(Number(event.target.value))}>{PROMPT_LIBRARY.map((entry, index) => <option key={entry.name} value={index}>{entry.name}</option>)}</select></label>
          <span className="muted sample-library-copy">Selecting a library entry places its full template in the Prompt box below. The library keeps <code>__trigger__</code> live rather than baking in the current project token.</span>
        </div>

        <label>Prompt template<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the sample. Use __trigger__ wherever the current project trigger should be bound." /></label>
        <div className="sample-resolved-preview"><span className="sample-preview-label">Resolved preview</span><TriggerTemplateText text={prompt || "Your prompt with __trigger__ will resolve here."} triggerWord={resolvedTrigger} /></div>

        <div className="sample-definition-grid sampling-definition-grid">
          <label>Width<input type="number" min={128} max={4096} step={8} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
          <label>Height<input type="number" min={128} max={4096} step={8} value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
          <div className="sampling-effective-pair">
            <label>{turbo ? "Configured CFG" : "CFG Scale"}<input type="number" min={0} max={30} step={0.1} value={cfgScale} disabled={turbo} onChange={(event) => setCfgScale(Number(event.target.value))} /></label>
            {turbo && <label className="sampling-effective-field">Effective CFG<input type="number" value={1.0} readOnly /></label>}
          </div>
          <label>Seed<input type="number" min={0} max={4294967295} value={editSeed} onChange={(event) => setEditSeed(Number(event.target.value))} /><span className="muted">Explicit seed for this probe. New samples default to 42.</span></label>
        </div>

        <div className="actions"><button className="primary" onClick={saveSample} disabled={saving || !prompt.trim()}>{saving ? "Saving…" : editId ? "Save Changes" : "Add Sample"}</button></div>
      </section>

      <section className="panel stack">
        <div className="sample-section-heading"><div><p className="eyebrow">Sample set</p><div className="card-title">{sampleCount} configured sample{sampleCount === 1 ? "" : "s"}</div></div></div>
        {sampleRows.length ? <div className="sample-list">{sampleRows.map((sample, index) => <article className="sample-list-item" key={sample.id}>
          <div className="sample-index">{index + 1}</div>
          <div className="sample-list-copy">
            <div className="sample-list-id">{sample.id}</div>
            <div className="sample-list-prompt"><TriggerTemplateText text={sample.prompt_template} triggerWord={resolvedTrigger} /></div>
            <div className="sample-list-meta"><span>{sample.width} × {sample.height}</span><span>{turbo ? `CFG 1.0 effective · ${configuredCfg(sample)} configured` : `CFG ${configuredCfg(sample)}`}</span><span>Seed {configuredSeed(sample)}</span></div>
          </div>
          <div className="sample-list-actions"><button className="secondary" onClick={() => beginEdit(sample)}>Edit</button><button className="secondary" onClick={() => void duplicateSample(sample)}>Duplicate</button><button className="danger" onClick={() => void deleteSample(sample)}>Delete</button></div>
        </article>)}</div> : <div className="sample-empty-state">No evaluation samples yet. Compose one above or start from the Prompt Library.</div>}
        <p className="muted sample-trigger-note">Sample templates retain <code>__trigger__</code>. At run preparation the harness freezes this project plan. Explicit per-sample seeds are preserved for the fizgig-web preview overlay; the underlying standalone CLI still receives its normal base-seed fallback.</p>
      </section>
    </fieldset>

    {message && <div className={message.toLowerCase().includes("unable") || message.toLowerCase().includes("invalid") ? "notice error" : "notice success"}>{message}</div>}

    <section className="panel sample-stage-footer"><div><strong>Sampling configuration</strong><div className="muted">{plan.enabled ? (sampleCount ? `${sampleCount} stable evaluation probe${sampleCount === 1 ? "" : "s"} ready to carry into training.` : "Sampling is enabled; add at least one probe before starting a sampled run.") : "Sampling is disabled; the saved probe configuration remains attached to the project."}</div></div><button className="primary" onClick={() => navigate("/training")}>Continue to <strong>Training</strong> →</button></section>
  </div>;
}
