import { useEffect, useMemo, useState } from "react";
import {
  generateCaption,
  getCaptioningOptions,
  getProjectRevision,
  inspectDataset,
  updateProjectCaption,
  unloadCaptionModels,
  type CaptionGenerateRequest,
  type CaptioningOptions,
} from "../api";
import { useSession } from "../session";

export function CaptionsPage() {
  const { project, revision, setRevision, dataset, setDataset, run, triggerWord } = useSession();
  const [selectedName, setSelectedName] = useState(revision?.assets[0]?.filename ?? "");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");
  const [message, setMessage] = useState("");
  const [options, setOptions] = useState<CaptioningOptions | null>(null);
  const [provider, setProvider] = useState<"qwen" | "florence">("qwen");
  const [qwenTask, setQwenTask] = useState("training");
  const [qwenInstruction, setQwenInstruction] = useState("");
  const [qwenModel, setQwenModel] = useState("");
  const [qwenProcessor, setQwenProcessor] = useState("");
  const [qwenRevision, setQwenRevision] = useState("");
  const [florenceModel, setFlorenceModel] = useState("MiaoshouAI/Florence-2-base-PromptGen");
  const [florenceTask, setFlorenceTask] = useState("<DETAILED_CAPTION>");
  const [maxTokens, setMaxTokens] = useState(120);
  const [addTriggerWord, setAddTriggerWord] = useState(true);

  const assets = revision?.assets ?? [];
  const selectedAsset = assets.find((asset) => asset.filename === selectedName) ?? assets[0];
  const selectedImage = dataset?.images.find((image) => image.filename === selectedAsset?.filename);
  const [captionDraft, setCaptionDraft] = useState(selectedAsset?.caption ?? "");

  const qwenProvider = options?.providers.find((item) => item.id === "qwen" && "tasks" in item);
  const florenceProvider = options?.providers.find((item) => item.id === "florence" && "models" in item);
  const activeQwenPreset = qwenProvider && "tasks" in qwenProvider ? qwenProvider.tasks[qwenTask] : undefined;

  useEffect(() => {
    getCaptioningOptions().then((result) => {
      setOptions(result);
      const qwen = result.providers.find((item) => item.id === "qwen" && "tasks" in item);
      const florence = result.providers.find((item) => item.id === "florence" && "models" in item);
      if (qwen && "tasks" in qwen) {
        setQwenTask(qwen.default_task); setQwenModel(qwen.default_model); setQwenProcessor(qwen.default_processor); setQwenRevision(qwen.default_revision);
        const preset = qwen.tasks[qwen.default_task]; if (preset) { setQwenInstruction(preset.instruction); setMaxTokens(preset.max_tokens); }
      }
      if (florence && "models" in florence) { setFlorenceModel(florence.default_model); setFlorenceTask(florence.default_task); }
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load captioning options"));
  }, []);

  useEffect(() => {
    if (!selectedAsset && assets[0]) { setSelectedName(assets[0].filename); setCaptionDraft(assets[0].caption); }
  }, [assets, selectedAsset]);

  const visibleAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((asset) => asset.filename.toLowerCase().includes(q) || asset.caption.toLowerCase().includes(q));
  }, [assets, query]);

  function selectImage(filename: string) {
    const asset = assets.find((item) => item.filename === filename);
    setSelectedName(filename); setCaptionDraft(asset?.caption ?? ""); setMessage("");
  }

  async function refreshRevision() {
    if (!project || !revision) return;
    const fresh = await getProjectRevision(project.id, revision.id);
    setRevision(fresh);
  }

  function generationRequest(): CaptionGenerateRequest {
    if (provider === "qwen") return { provider, model: qwenModel.trim() || undefined, processor: qwenProcessor.trim() || undefined, revision: qwenRevision.trim() || undefined, task: qwenTask, instruction: qwenInstruction.trim() || undefined, max_tokens: maxTokens, trigger_word: triggerWord, add_trigger_word: addTriggerWord, save: false };
    return { provider, model: florenceModel, task: florenceTask, max_tokens: maxTokens, trigger_word: triggerWord, add_trigger_word: addTriggerWord, save: false };
  }

  function captionMetadata() {
    return provider === "qwen"
      ? { source: "ai", provider, model: qwenModel, processor: qwenProcessor, model_revision: qwenRevision, task: qwenTask, instruction: qwenInstruction, max_tokens: maxTokens, trigger_word_added: addTriggerWord }
      : { source: "ai", provider, model: florenceModel, task: florenceTask, max_tokens: maxTokens, trigger_word_added: addTriggerWord };
  }

  async function saveCanonical(filename: string, caption: string, reason: string, metadata: Record<string, unknown>) {
    if (!project || !revision) throw new Error("Open a project revision first");
    const result = await updateProjectCaption(project.id, revision.id, filename, {
      caption,
      reason,
      metadata,
      materialize: Boolean(run),
      run_id: run?.id,
    });
    await refreshRevision();
    return result;
  }

  async function onSave() {
    if (!selectedAsset) return;
    setSaving(true); setMessage("");
    try {
      const result = await saveCanonical(selectedAsset.filename, captionDraft, "manual_edit", { source: "manual", page: "captions" });
      setCaptionDraft(result.caption);
      setMessage(result.changed ? "Caption saved to project history" : "Caption unchanged");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save caption"); } finally { setSaving(false); }
  }

  async function regenerateSelected() {
    if (!dataset || !selectedAsset) return;
    setGenerating(true); setMessage(`Captioning ${selectedAsset.filename}…`);
    try {
      const result = await generateCaption(dataset.id, selectedAsset.filename, generationRequest());
      setCaptionDraft(result.caption);
      setMessage("Generated caption is in the editor. Review it, then Save Caption to commit it to project history.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Caption generation failed"); } finally { setGenerating(false); }
  }

  async function generateMissing() {
    if (!dataset || !revision) return;
    const missing = revision.assets.filter((asset) => !asset.caption.trim());
    if (!missing.length) { setMessage("All project assets already have captions."); return; }
    setGenerating(true); setMessage("");
    let completed = 0; let failed = 0;
    try {
      for (const asset of missing) {
        setBulkProgress(`${completed + failed + 1} / ${missing.length} · ${asset.filename}`);
        try {
          const result = await generateCaption(dataset.id, asset.filename, generationRequest());
          await saveCanonical(asset.filename, result.caption, "ai_generate_missing", captionMetadata());
          if (asset.filename === selectedAsset?.filename) setCaptionDraft(result.caption);
          completed += 1;
        } catch (err) { failed += 1; setMessage(err instanceof Error ? err.message : `Failed on ${asset.filename}`); }
      }
      setDataset(await inspectDataset(revision.files_path));
      await refreshRevision();
      setMessage(`Generate Missing finished: ${completed} committed to project history${failed ? `, ${failed} failed` : ""}.`);
    } finally { setBulkProgress(""); setGenerating(false); }
  }

  function chooseQwenTask(task: string) {
    setQwenTask(task);
    if (qwenProvider && "tasks" in qwenProvider) { const preset = qwenProvider.tasks[task]; if (preset) { setQwenInstruction(preset.instruction); setMaxTokens(preset.max_tokens); } }
  }

  if (!project || !revision || !dataset) return <section className="panel hero-panel stack"><p className="eyebrow">Project required</p><h1>Captions</h1><p className="muted">Open a project and working dataset on the Start page first.</p></section>;

  return (
    <div className="stack">
      <header className="page-header">
        <div><p className="eyebrow">{project.name} · {revision.name}</p><h1>Captions</h1><p className="muted">Project JSON is authoritative. Trainer .txt sidecars are generated only when Fizgig needs them.</p></div>
        <div className="actions"><button className="primary" onClick={generateMissing} disabled={generating}>{generating && bulkProgress ? bulkProgress : "Generate Missing"}</button><button className="secondary" onClick={() => unloadCaptionModels()} disabled={generating}>Unload AI model</button></div>
      </header>
      <div className="caption-layout">
        <section className="panel">
          <div className="toolbar"><input placeholder="Search filenames or captions…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="muted">{visibleAssets.length} / {assets.length}</span></div>
          <div className="thumb-grid caption-grid">
            {visibleAssets.map((asset) => { const image = dataset.images.find((item) => item.filename === asset.filename); return image ? <button className={`thumb caption-thumb ${selectedAsset?.filename === asset.filename ? "selected" : ""}`} key={asset.filename} onClick={() => selectImage(asset.filename)} title={asset.filename}><img src={image.image_url} alt={asset.filename} />{!asset.caption.trim() && <span className="missing-dot" title="Missing caption" />}</button> : null; })}
          </div>
        </section>
        <section className="panel stack">
          {selectedAsset && selectedImage ? <>
            <div><div className="card-title">{selectedAsset.filename}</div><div className="muted">{assets.findIndex((asset) => asset.filename === selectedAsset.filename) + 1} / {assets.length} · canonical project caption</div></div>
            <div className="caption-preview"><img src={selectedImage.image_url} alt={selectedAsset.filename} /></div>
            <label>Caption<textarea value={captionDraft} onChange={(event) => setCaptionDraft(event.target.value)} /></label>
            {message && <div className={message.includes("failed") || message.includes("requires") || message.includes("not configured") ? "notice error" : "notice success"}>{message}</div>}
            <div className="actions"><button className="secondary" onClick={regenerateSelected} disabled={generating}>{generating ? "Generating…" : "Regenerate with AI"}</button><button className="primary" onClick={onSave} disabled={saving || generating}>{saving ? "Saving…" : "Save Caption"}</button></div>
            <div className="caption-ai-section stack">
              <div className="card-title">AI Captioning</div>
              <div className="form-row"><label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as "qwen" | "florence")}><option value="qwen">Qwen3-VL</option><option value="florence">Florence-2</option></select></label><label>Max tokens<input type="number" min={16} max={1024} value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></label></div>
              {provider === "qwen" ? <>
                <label>Caption model / checkpoint<input value={qwenModel} onChange={(event) => setQwenModel(event.target.value)} placeholder="Qwen/Qwen3-VL-8B-Instruct or /workspace/models/my-qwen" /><span className="muted">Hugging Face repo ID or HF-compatible local model directory; independent of the training encoder.</span></label>
                <div className="form-row"><label>Processor override <span className="muted">Optional</span><input value={qwenProcessor} onChange={(event) => setQwenProcessor(event.target.value)} placeholder="Leave blank to use model source" /></label><label>Revision <span className="muted">Optional</span><input value={qwenRevision} onChange={(event) => setQwenRevision(event.target.value)} placeholder="branch, tag, or commit" /></label></div>
                <label>Caption preset<select value={qwenTask} onChange={(event) => chooseQwenTask(event.target.value)}>{qwenProvider && "tasks" in qwenProvider ? Object.entries(qwenProvider.tasks).map(([key, task]) => <option key={key} value={key}>{task.label}</option>) : <option value="training">Training caption (viewpoint-aware)</option>}</select></label>
                <label>Captioning instruction — editable prompt override<textarea className="instruction-editor" value={qwenInstruction} onChange={(event) => setQwenInstruction(event.target.value)} /></label>
                <div className="prompt-actions"><span className="muted">Every committed AI caption records this model, preset and resolved instruction in project history.</span><button className="secondary" onClick={() => activeQwenPreset && setQwenInstruction(activeQwenPreset.instruction)} disabled={!activeQwenPreset}>Restore preset</button></div>
              </> : <>
                <label>Florence model<select value={florenceModel} onChange={(event) => setFlorenceModel(event.target.value)}>{florenceProvider && "models" in florenceProvider ? florenceProvider.models.map((model) => <option key={model} value={model}>{model}</option>) : <option value={florenceModel}>{florenceModel}</option>}</select></label>
                <label>Florence task<select value={florenceTask} onChange={(event) => setFlorenceTask(event.target.value)}>{florenceProvider && "tasks" in florenceProvider ? florenceProvider.tasks.map((task) => <option key={task} value={task}>{task}</option>) : <option value={florenceTask}>{florenceTask}</option>}</select></label>
              </>}
              <label className="inline-check"><input type="checkbox" checked={addTriggerWord} onChange={(event) => setAddTriggerWord(event.target.checked)} /> Add trigger word automatically <span className="muted">({triggerWord})</span></label>
            </div>
          </> : <p className="muted">No image selected.</p>}
        </section>
      </div>
    </div>
  );
}
