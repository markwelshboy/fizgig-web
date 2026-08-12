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
  const [prompt, setPrompt] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [cfgScale, setCfgScale] = useState(4.5);
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
  const currentSeed = editId ? editSeed : (plan?.authoring.seed_value ?? 42);
  const resolvedTrigger = project?.trigger_word?.trim() || triggerWord.trim();
  const sampleCount = plan?.samples.length ?? 0;

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

  function resetEditor(keepShape = true) {
    setEditId(null);
    setPrompt("");
    if (!keepShape) { setWidth(1024); setHeight(1024); setCfgScale(4.5); }
    setEditSeed(plan?.authoring.seed_value ?? 42);
  }

  function useLibraryPrompt() {
    setPrompt(PROMPT_LIBRARY[libraryIndex].template);
  }

  async function saveSample() {
    if (!plan || !project || !prompt.trim()) return;
    const concreteSeed = editId ? editSeed : plan.authoring.seed_value;
    const definition: SampleDefinition = {
      id: editId ?? nextSampleId(plan.samples),
      prompt_template: prompt.trim(),
      width: Math.max(128, Math.round(width)),
      height: Math.max(128, Math.round(height)),
      cfg_scale: Math.max(0, Number(cfgScale)),
      seed: Math.max(0, Math.round(concreteSeed)),
    };

    let samples: SampleDefinition[];
    let authoring = plan.authoring;
    if (editId) {
      samples = plan.samples.map((sample) => sample.id === editId ? definition : sample);
    } else {
      samples = [...plan.samples, definition];
      if (plan.authoring.seed_mode === "increment") {
        authoring = { ...plan.authoring, seed_value: Math.min(4294967295, plan.authoring.seed_value + 1) };
      }
    }

    const next = { ...plan, samples, authoring };
    await persist(next, editId ? `${definition.id} updated.` : `${definition.id} added to the sampling set.`);
    setEditId(null);
    setPrompt("");
    setEditSeed(authoring.seed_value);
  }

  function beginEdit(sample: SampleDefinition) {
    setEditId(sample.id);
    setPrompt(sample.prompt_template);
    setWidth(sample.width);
    setHeight(sample.height);
    setCfgScale(sample.cfg_scale);
    setEditSeed(sample.seed);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function duplicateSample(sample: SampleDefinition) {
    if (!plan) return;
    const copy = { ...sample, id: nextSampleId(plan.samples) };
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
    <header className="page-header"><div><p className="eyebrow">Evaluation probes</p><h1>Sampling</h1><p className="muted">Build a stable set of prompts, dimensions, guidance values and seeds to compare progress throughout training.</p></div></header>

    <section className="panel stack sample-editor-panel">
      <div className="sample-section-heading"><div><p className="eyebrow">{editId ? "Edit sample" : "New sample"}</p><div className="card-title">{editId ?? "Compose an evaluation sample"}</div></div>{editId && <button className="secondary" onClick={() => resetEditor()}>Cancel edit</button>}</div>

      <div className="sample-library-row">
        <label>Prompt Library<select value={libraryIndex} onChange={(event) => setLibraryIndex(Number(event.target.value))}>{PROMPT_LIBRARY.map((entry, index) => <option key={entry.name} value={index}>{entry.name}</option>)}</select></label>
        <button className="secondary" onClick={useLibraryPrompt}>Use Prompt</button>
        <span className="muted">Starter library for this POC; the five templates can be replaced with your final set.</span>
      </div>

      <label>Prompt template<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the sample. Use __trigger__ wherever the current project trigger should be bound." /></label>
      <div className="sample-resolved-preview"><span className="sample-preview-label">Resolved preview</span><TriggerTemplateText text={prompt || "Your prompt with __trigger__ will resolve here."} triggerWord={resolvedTrigger} /></div>

      <div className="sample-definition-grid">
        <label>Width<input type="number" min={128} max={4096} step={8} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
        <label>Height<input type="number" min={128} max={4096} step={8} value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
        <label>CFG Scale<input type="number" min={0} max={30} step={0.1} value={cfgScale} onChange={(event) => setCfgScale(Number(event.target.value))} /><span className="muted">Stored per sample even when the distilled sampler does not use CFG.</span></label>
        {editId ? <label>Seed<input type="number" min={0} max={4294967295} value={editSeed} onChange={(event) => setEditSeed(Number(event.target.value))} /><span className="muted">Concrete seed stored with this sample.</span></label> : <div className="sample-seed-authoring">
          <span className="caption-control-label">Seed assignment</span>
          <div className="sample-seed-modes">
            <label className="inline-check"><input type="radio" name="seed-mode" checked={plan.authoring.seed_mode === "fixed"} onChange={() => patchPlan({ authoring: { ...plan.authoring, seed_mode: "fixed" } })} /> Fixed Seed</label>
            <label className="inline-check"><input type="radio" name="seed-mode" checked={plan.authoring.seed_mode === "increment"} onChange={() => patchPlan({ authoring: { ...plan.authoring, seed_mode: "increment" } })} /> Auto Increment</label>
          </div>
          <label>{plan.authoring.seed_mode === "fixed" ? "Seed" : "Next seed"}<input type="number" min={0} max={4294967295} value={plan.authoring.seed_value} onChange={(event) => patchPlan({ authoring: { ...plan.authoring, seed_value: Math.max(0, Number(event.target.value)) } })} /></label>
        </div>}
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
          <div className="sample-list-meta"><span>{sample.width} × {sample.height}</span><span>CFG {sample.cfg_scale}</span><span>Seed {sample.seed}</span></div>
        </div>
        <div className="sample-list-actions"><button className="secondary" onClick={() => beginEdit(sample)}>Edit</button><button className="secondary" onClick={() => void duplicateSample(sample)}>Duplicate</button><button className="danger" onClick={() => void deleteSample(sample)}>Delete</button></div>
      </article>)}</div> : <div className="sample-empty-state">No evaluation samples yet. Compose one above or start from the Prompt Library.</div>}
      <p className="muted sample-trigger-note">Sample templates retain <code>__trigger__</code>. The list resolves that token against the current project trigger; run preparation will later snapshot both the trigger and fully resolved prompt.</p>
    </section>

    <section className="panel stack">
      <div><p className="eyebrow">Generation schedule</p><div className="card-title">When to render the sample set</div></div>
      <div className="sample-settings-grid">
        <label className="inline-check"><input type="checkbox" checked={plan.enabled} onChange={(event) => patchPlan({ enabled: event.target.checked })} /> Enable sampling</label>
        <label className="inline-check"><input type="checkbox" checked={plan.schedule.sample_at_start} onChange={(event) => patchPlan({ schedule: { ...plan.schedule, sample_at_start: event.target.checked } })} /> Sample at start</label>
        <label>Every N epochs<input type="number" min={0} value={plan.schedule.every_n_epochs} onChange={(event) => patchPlan({ schedule: { ...plan.schedule, every_n_epochs: Number(event.target.value) } })} /><span className="muted">0 disables epoch cadence.</span></label>
        <label>Every N steps<input type="number" min={0} value={plan.schedule.every_n_steps} onChange={(event) => patchPlan({ schedule: { ...plan.schedule, every_n_steps: Number(event.target.value) } })} /><span className="muted">0 disables step cadence.</span></label>
      </div>
    </section>

    <section className="panel stack">
      <div><p className="eyebrow">Sampling engine</p><div className="card-title">Shared renderer settings</div><p className="muted">Prompt, dimensions, CFG and concrete seed stay per sample. These controls describe how the entire set is rendered.</p></div>
      <div className="sample-settings-grid">
        <label className="inline-check"><input type="checkbox" checked={plan.renderer.use_distilled} onChange={(event) => patchPlan({ renderer: { ...plan.renderer, use_distilled: event.target.checked } })} /> Use distilled / turbo model for samples</label>
        <label>Cache sample model<select value={plan.renderer.cache_model} onChange={(event) => patchPlan({ renderer: { ...plan.renderer, cache_model: event.target.value as SamplingPlan["renderer"]["cache_model"] } })}><option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option></select></label>
        <label>Steps<input type="number" min={1} max={500} value={plan.renderer.steps} onChange={(event) => patchPlan({ renderer: { ...plan.renderer, steps: Number(event.target.value) } })} /></label>
        <label>Flow Shift <span className="muted">Optional</span><input type="number" min={0} step={0.1} value={plan.renderer.flow_shift ?? ""} placeholder="Model default" onChange={(event) => patchPlan({ renderer: { ...plan.renderer, flow_shift: event.target.value === "" ? null : Number(event.target.value) } })} /></label>
      </div>
      <label>Negative prompt<textarea value={plan.renderer.negative_prompt} onChange={(event) => patchPlan({ renderer: { ...plan.renderer, negative_prompt: event.target.value } })} /></label>
      <div className="sample-distilled-note">{plan.renderer.use_distilled ? "Distilled sampling selected. Per-sample CFG values remain stored so the same probes can be reused unchanged with an undistilled renderer." : "Undistilled sampling selected. Each sample's CFG Scale will be applied."}</div>
      <div className="actions"><button className="secondary" onClick={() => void saveSettings()} disabled={saving || !dirty}>{saving ? "Saving…" : "Save Sampling Settings"}</button></div>
    </section>

    {message && <div className={message.toLowerCase().includes("unable") || message.toLowerCase().includes("invalid") ? "notice error" : "notice success"}>{message}</div>}

    <section className="panel sample-stage-footer"><div><strong>Sampling configuration</strong><div className="muted">{sampleCount ? `${sampleCount} stable evaluation probe${sampleCount === 1 ? "" : "s"} ready to carry into training.` : "Sampling is optional; add probes if you want consistent visual comparisons during training."}</div></div><button className="primary" onClick={() => navigate("/training")}>Continue to <strong>Training</strong> →</button></section>
  </div>;
}
