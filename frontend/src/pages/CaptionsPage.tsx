import { useEffect, useMemo, useState } from "react";
import {
  getCaptioningOptions,
  getProjectRevision,
  getProjectRevisionPolicy,
  updateCaptionValidationPolicy,
  updateProjectAssetPolicy,
  updateProjectCaption,
  unloadCaptionModels,
  type AssetTrainingPolicy,
  type AutoRecaptionPolicy,
  type CaptionGenerateRequest,
  type CaptioningOptions,
  type ProjectRevisionPolicy,
} from "../api";
import { generateProjectAssetCaption, preparedProjectAssetUrl } from "../project-captioning-api";
import { useSession } from "../session";

const CAROUSEL_SIZE = 7;
const CAROUSEL_RADIUS = Math.floor(CAROUSEL_SIZE / 2);

export function CaptionsPage() {
  const { project, revision, setRevision, run, triggerWord } = useSession();
  const initialAsset = revision?.assets.find((asset) => asset.included !== false);
  const [selectedName, setSelectedName] = useState(initialAsset?.filename ?? "");
  const [query, setQuery] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiCandidate, setAiCandidate] = useState("");
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
  const [policy, setPolicy] = useState<ProjectRevisionPolicy | null>(null);
  const [protectedDraft, setProtectedDraft] = useState("");
  const [acceptedWordsDraft, setAcceptedWordsDraft] = useState("");
  const [spellcheckEnabled, setSpellcheckEnabled] = useState(true);
  const [policySaving, setPolicySaving] = useState(false);

  const assets = (revision?.assets ?? []).filter((asset) => asset.included !== false);
  const selectedAsset = assets.find((asset) => asset.filename === selectedName) ?? assets[0];
  const selectedIndex = selectedAsset ? assets.findIndex((asset) => asset.filename === selectedAsset.filename) : -1;
  const [captionDraft, setCaptionDraft] = useState(selectedAsset?.caption ?? "");

  const qwenProvider = options?.providers.find((item) => item.id === "qwen" && "tasks" in item);
  const florenceProvider = options?.providers.find((item) => item.id === "florence" && "models" in item);
  const activeQwenPreset = qwenProvider && "tasks" in qwenProvider ? qwenProvider.tasks[qwenTask] : undefined;
  const selectedPolicy = selectedAsset
    ? { training_policy: "automatic" as AssetTrainingPolicy, auto_recaption_policy: "automatic" as AutoRecaptionPolicy, ...(policy?.assets[selectedAsset.filename] ?? {}) }
    : null;
  const captionChanged = Boolean(selectedAsset && captionDraft !== selectedAsset.caption);

  useEffect(() => {
    getCaptioningOptions().then((result) => {
      setOptions(result);
      const qwen = result.providers.find((item) => item.id === "qwen" && "tasks" in item);
      const florence = result.providers.find((item) => item.id === "florence" && "models" in item);
      if (qwen && "tasks" in qwen) {
        setQwenTask(qwen.default_task);
        setQwenModel(qwen.default_model);
        setQwenProcessor(qwen.default_processor);
        setQwenRevision(qwen.default_revision);
        const preset = qwen.tasks[qwen.default_task];
        if (preset) { setQwenInstruction(preset.instruction); setMaxTokens(preset.max_tokens); }
      }
      if (florence && "models" in florence) { setFlorenceModel(florence.default_model); setFlorenceTask(florence.default_task); }
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load captioning options"));
  }, []);

  useEffect(() => {
    if (!project || !revision) return;
    getProjectRevisionPolicy(project.id, revision.id).then((result) => {
      setPolicy(result);
      setProtectedDraft(result.caption_validation.protected_phrases.join("\n"));
      setAcceptedWordsDraft(result.caption_validation.accepted_words.join(", "));
      setSpellcheckEnabled(result.caption_validation.spellcheck_enabled);
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load caption policy"));
  }, [project?.id, revision?.id]);

  useEffect(() => {
    if (!selectedAsset && assets[0]) {
      setSelectedName(assets[0].filename);
      setCaptionDraft(assets[0].caption);
      setAiCandidate("");
    }
  }, [assets, selectedAsset]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); navigateBy(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); navigateBy(1); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const visibleAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((asset) => asset.filename.toLowerCase().includes(q) || asset.caption.toLowerCase().includes(q));
  }, [assets, query]);

  const carouselAssets = useMemo(() => {
    if (!assets.length || selectedIndex < 0) return [];
    const count = Math.min(CAROUSEL_SIZE, assets.length);
    const radius = Math.floor(count / 2);
    return Array.from({ length: count }, (_, offset) => assets[(selectedIndex + offset - radius + assets.length) % assets.length]);
  }, [assets, selectedIndex]);

  const browserAssets = useMemo(() => {
    if (query.trim() || selectedIndex < 0 || assets.length <= 1) return visibleAssets;
    const start = (selectedIndex - CAROUSEL_RADIUS + assets.length) % assets.length;
    return Array.from({ length: assets.length }, (_, offset) => assets[(start + offset) % assets.length]);
  }, [assets, selectedIndex, visibleAssets, query]);

  const protectedMatches = useMemo(() => {
    const haystack = captionDraft.toLowerCase();
    return (policy?.caption_validation.protected_phrases ?? []).filter((phrase) => phrase && haystack.includes(phrase.toLowerCase()));
  }, [captionDraft, policy]);

  function imageUrl(filename: string) {
    if (!project || !revision) return "";
    return preparedProjectAssetUrl(project.id, revision.id, filename);
  }

  function selectImage(filename: string) {
    const asset = assets.find((item) => item.filename === filename);
    setSelectedName(filename);
    setCaptionDraft(asset?.caption ?? "");
    setAiCandidate("");
    setMessage("");
  }

  function navigateBy(delta: number) {
    if (!assets.length || selectedIndex < 0) return;
    selectImage(assets[(selectedIndex + delta + assets.length) % assets.length].filename);
  }

  function policyFor(filename: string) {
    return { training_policy: "automatic", auto_recaption_policy: "automatic", ...(policy?.assets[filename] ?? {}) };
  }

  function assetStatus(asset: (typeof assets)[number]) {
    const itemPolicy = policyFor(asset.filename);
    return {
      missing: !asset.caption.trim(),
      alwaysTrain: itemPolicy.training_policy === "always_train",
      held: itemPolicy.auto_recaption_policy === "hold",
      locked: itemPolicy.auto_recaption_policy === "never",
    };
  }

  async function refreshRevision() {
    if (!project || !revision) return;
    setRevision(await getProjectRevision(project.id, revision.id));
  }

  function generationRequest(): CaptionGenerateRequest {
    if (provider === "qwen") return { provider, model: qwenModel.trim() || undefined, processor: qwenProcessor.trim() || undefined, revision: qwenRevision.trim() || undefined, task: qwenTask, instruction: qwenInstruction.trim() || undefined, max_tokens: maxTokens, trigger_word: triggerWord, add_trigger_word: addTriggerWord, save: false };
    return { provider, model: florenceModel, task: florenceTask, max_tokens: maxTokens, trigger_word: triggerWord, add_trigger_word: addTriggerWord, save: false };
  }

  function captionMetadata() {
    return provider === "qwen"
      ? { source: "ai", provider, model: qwenModel, processor: qwenProcessor, model_revision: qwenRevision, task: qwenTask, instruction: qwenInstruction, max_tokens: maxTokens, trigger_word_added: addTriggerWord, prepared_asset: true }
      : { source: "ai", provider, model: florenceModel, task: florenceTask, max_tokens: maxTokens, trigger_word_added: addTriggerWord, prepared_asset: true };
  }

  async function saveCanonical(filename: string, caption: string, reason: string, metadata: Record<string, unknown>) {
    if (!project || !revision) throw new Error("Open a project revision first");
    const result = await updateProjectCaption(project.id, revision.id, filename, { caption, reason, metadata, materialize: Boolean(run), run_id: run?.id });
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
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save caption"); }
    finally { setSaving(false); }
  }

  async function generateCandidate() {
    if (!project || !revision || !selectedAsset) return;
    setGenerating(true); setMessage(`Generating candidate for ${selectedAsset.filename}…`);
    try {
      const result = await generateProjectAssetCaption(project.id, revision.id, selectedAsset.filename, generationRequest());
      setAiCandidate(result.caption);
      setMessage("AI candidate generated. Your Working Caption has not been changed.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Caption generation failed"); }
    finally { setGenerating(false); }
  }

  async function generateMissing() {
    if (!project || !revision) return;
    const missing = assets.filter((asset) => !asset.caption.trim());
    if (!missing.length) { setMessage("All included working assets already have captions."); return; }
    setGenerating(true); setMessage("");
    let completed = 0; let failed = 0;
    try {
      for (const asset of missing) {
        setBulkProgress(`${completed + failed + 1} / ${missing.length} · ${asset.filename}`);
        try {
          const result = await generateProjectAssetCaption(project.id, revision.id, asset.filename, generationRequest());
          await saveCanonical(asset.filename, result.caption, "ai_generate_missing", captionMetadata());
          if (asset.filename === selectedAsset?.filename) setCaptionDraft(result.caption);
          completed += 1;
        } catch (err) { failed += 1; setMessage(err instanceof Error ? err.message : `Failed on ${asset.filename}`); }
      }
      await refreshRevision();
      setMessage(`Generate Missing finished: ${completed} committed to project history${failed ? `, ${failed} failed` : ""}.`);
    } finally { setBulkProgress(""); setGenerating(false); }
  }

  function chooseQwenTask(task: string) {
    setQwenTask(task);
    if (qwenProvider && "tasks" in qwenProvider) {
      const preset = qwenProvider.tasks[task];
      if (preset) { setQwenInstruction(preset.instruction); setMaxTokens(preset.max_tokens); }
    }
  }

  async function saveValidationPolicy() {
    if (!project || !revision) return;
    setPolicySaving(true); setMessage("");
    try {
      const protected_phrases = protectedDraft.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
      const accepted_words = acceptedWordsDraft.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
      const next = await updateCaptionValidationPolicy(project.id, revision.id, { protected_phrases, spellcheck_enabled: spellcheckEnabled, accepted_words });
      setPolicy(next);
      setMessage("Caption policy saved to project history.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save caption policy"); }
    finally { setPolicySaving(false); }
  }

  async function setAssetPolicy(training_policy?: AssetTrainingPolicy, auto_recaption_policy?: AutoRecaptionPolicy) {
    if (!project || !revision || !selectedAsset) return;
    setPolicySaving(true); setMessage("");
    try {
      const next = await updateProjectAssetPolicy(project.id, revision.id, selectedAsset.filename, { training_policy, auto_recaption_policy });
      setPolicy(next);
      setMessage(`${selectedAsset.filename} training policy saved.`);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save asset policy"); }
    finally { setPolicySaving(false); }
  }

  function AssetThumb({ asset, compact = false }: { asset: (typeof assets)[number]; compact?: boolean }) {
    const status = assetStatus(asset);
    return <button className={`caption-nav-card ${compact ? "compact" : ""} ${selectedAsset?.filename === asset.filename ? "selected" : ""}`} onClick={() => selectImage(asset.filename)} title={asset.filename}>
      <img src={imageUrl(asset.filename)} alt={asset.filename} />
      <span className="caption-nav-name">{asset.filename}</span>
      <span className="caption-nav-badges">
        {status.missing && <span className="caption-status-dot missing" title="Missing caption" />}
        {status.alwaysTrain && <span className="caption-status-chip" title="Always Train">Train</span>}
        {status.held && <span className="caption-status-chip" title="Auto-recaption held">Hold</span>}
        {status.locked && <span className="caption-status-chip" title="Auto-recaption disabled">Lock</span>}
      </span>
    </button>;
  }

  if (!project || !revision) return <section className="panel hero-panel stack"><p className="eyebrow">Project required</p><h1>Captions</h1><p className="muted">Open a project and working revision on the Start page first.</p></section>;

  return <div className="stack caption-page">
    <header className="page-header"><div><p className="eyebrow">{project.name} · {revision.name}</p><h1>Captions</h1><p className="muted">Image + caption is the primary project unit. AI assistance is optional; project JSON remains authoritative.</p></div></header>

    <section className="panel stack">
      <div><p className="eyebrow">Caption policy</p><div className="card-title">Validation & protected traits</div><p className="muted">Protected phrases are traits you want the LoRA to learn rather than repeatedly name. Fizgig flags them instead of silently deleting them. The trigger word is always exempt from spellcheck.</p></div>
      <div className="form-row">
        <label>Protected traits / phrases<textarea value={protectedDraft} onChange={(event) => setProtectedDraft(event.target.value)} placeholder={"blonde hair\nblue eyes"} /><span className="muted">One per line or comma-separated.</span></label>
        <label>Accepted spellings<input value={acceptedWordsDraft} onChange={(event) => setAcceptedWordsDraft(event.target.value)} placeholder="LoKR, Welsh, product-name" /><span className="muted">Project dictionary for intentional words spellcheck should ignore.</span></label>
      </div>
      <div className="actions"><label className="inline-check"><input type="checkbox" checked={spellcheckEnabled} onChange={(event) => setSpellcheckEnabled(event.target.checked)} /> Spellcheck captions</label><button className="secondary" onClick={saveValidationPolicy} disabled={policySaving}>{policySaving ? "Saving…" : "Save caption policy"}</button></div>
    </section>

    {selectedAsset ? <section className="panel caption-unit-panel">
      <div className="caption-review-heading">
        <div><p className="eyebrow">Caption review</p><div className="card-title">{selectedAsset.filename}</div></div>
        <div className="caption-review-position">{selectedIndex + 1} / {assets.length}</div>
      </div>

      <div className="caption-unit-top">
        <div className="caption-unit-image"><div className="caption-review-canvas"><img src={imageUrl(selectedAsset.filename)} alt={selectedAsset.filename} /></div></div>
        <div className="caption-unit-copy stack">
          <label className="caption-editor-label">Working Caption<textarea value={captionDraft} onChange={(event) => setCaptionDraft(event.target.value)} /></label>
          <div className="saved-caption-block">
            <div className="saved-caption-heading"><strong>Saved Project Caption</strong>{captionChanged && <span className="caption-dirty-chip">Unsaved changes</span>}</div>
            <div className={`saved-caption-text ${selectedAsset.caption.trim() ? "" : "empty"}`}>{selectedAsset.caption.trim() || "No saved caption yet."}</div>
          </div>
          {protectedMatches.length > 0 && <div className="notice error">Protected phrase{protectedMatches.length === 1 ? "" : "s"} present: <strong>{protectedMatches.join(", ")}</strong>. Review before training.</div>}
          {message && <div className={message.includes("failed") || message.includes("requires") || message.includes("not configured") ? "notice error" : "notice success"}>{message}</div>}
          <div className="actions caption-save-actions"><button className="primary" onClick={onSave} disabled={saving || generating || !captionChanged}>{saving ? "Saving…" : "Save Caption"}</button></div>
        </div>
      </div>

      <div className="caption-intervention-row">
        <div className="caption-intervention-title">Training Intervention <span className="caption-info" title="The loss watcher keeps its real verdict. These policies only control what Fizgig is allowed to do in response.">i</span></div>
        <fieldset className="caption-segment-group"><legend>Training Response</legend><div className="caption-segments">
          <label className={selectedPolicy?.training_policy === "automatic" ? "selected" : ""}><input type="radio" name="training-policy" checked={selectedPolicy?.training_policy === "automatic"} onChange={() => setAssetPolicy("automatic", undefined)} disabled={policySaving} />Automatic</label>
          <label className={selectedPolicy?.training_policy === "always_train" ? "selected" : ""}><input type="radio" name="training-policy" checked={selectedPolicy?.training_policy === "always_train"} onChange={() => setAssetPolicy("always_train", undefined)} disabled={policySaving} />Always Train</label>
        </div></fieldset>
        <fieldset className="caption-segment-group"><legend>Auto-Recaption</legend><div className="caption-segments">
          <label className={selectedPolicy?.auto_recaption_policy === "automatic" ? "selected" : ""}><input type="radio" name="recaption-policy" checked={selectedPolicy?.auto_recaption_policy === "automatic"} onChange={() => setAssetPolicy(undefined, "automatic")} disabled={policySaving} />Automatic</label>
          <label className={selectedPolicy?.auto_recaption_policy === "hold" ? "selected" : ""}><input type="radio" name="recaption-policy" checked={selectedPolicy?.auto_recaption_policy === "hold"} onChange={() => setAssetPolicy(undefined, "hold")} disabled={policySaving} />Hold</label>
          <label className={selectedPolicy?.auto_recaption_policy === "never" ? "selected" : ""}><input type="radio" name="recaption-policy" checked={selectedPolicy?.auto_recaption_policy === "never"} onChange={() => setAssetPolicy(undefined, "never")} disabled={policySaving} />Never</label>
        </div></fieldset>
      </div>
    </section> : <section className="panel"><p className="muted">No included image selected.</p></section>}

    {selectedAsset && <section className={`panel caption-ai-drawer ${aiOpen ? "open" : ""}`}>
      <button className="caption-ai-toggle" onClick={() => setAiOpen((open) => !open)} aria-expanded={aiOpen}>
        <span><strong>AI Captioning Assistant</strong><span className="muted"> Optional tool — generate a candidate without changing the Working Caption</span></span>
        <span className={`caption-browser-chevron ${aiOpen ? "open" : ""}`}>⌄</span>
      </button>
      {aiOpen && <div className="caption-ai-body stack">
        <div className="caption-ai-toolbar">
          <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as "qwen" | "florence")}><option value="qwen">Qwen3-VL</option><option value="florence">Florence-2</option></select></label>
          <label>Max tokens<input type="number" min={16} max={1024} value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></label>
          <label className="inline-check"><input type="checkbox" checked={addTriggerWord} onChange={(event) => setAddTriggerWord(event.target.checked)} /> Add trigger <span className="muted">({triggerWord})</span></label>
        </div>
        {provider === "qwen" ? <>
          <label>Caption model / checkpoint<input value={qwenModel} onChange={(event) => setQwenModel(event.target.value)} placeholder="Qwen/Qwen3-VL-8B-Instruct or /workspace/models/my-qwen" /></label>
          <div className="form-row"><label>Processor override <span className="muted">Optional</span><input value={qwenProcessor} onChange={(event) => setQwenProcessor(event.target.value)} placeholder="Leave blank to use model source" /></label><label>Revision <span className="muted">Optional</span><input value={qwenRevision} onChange={(event) => setQwenRevision(event.target.value)} placeholder="branch, tag, or commit" /></label></div>
          <label>Caption preset<select value={qwenTask} onChange={(event) => chooseQwenTask(event.target.value)}>{qwenProvider && "tasks" in qwenProvider ? Object.entries(qwenProvider.tasks).map(([key, task]) => <option key={key} value={key}>{task.label}</option>) : <option value="training">Training caption (viewpoint-aware)</option>}</select></label>
          <label>Captioning instruction — editable preset<textarea className="instruction-editor" value={qwenInstruction} onChange={(event) => setQwenInstruction(event.target.value)} /></label>
          <div className="prompt-actions"><span className="muted">Candidate generation is transient until you explicitly use or save it.</span><button className="secondary" onClick={() => activeQwenPreset && setQwenInstruction(activeQwenPreset.instruction)} disabled={!activeQwenPreset}>Restore preset</button></div>
        </> : <>
          <label>Florence model<select value={florenceModel} onChange={(event) => setFlorenceModel(event.target.value)}>{florenceProvider && "models" in florenceProvider ? florenceProvider.models.map((model) => <option key={model} value={model}>{model}</option>) : <option value={florenceModel}>{florenceModel}</option>}</select></label>
          <label>Florence task<select value={florenceTask} onChange={(event) => setFlorenceTask(event.target.value)}>{florenceProvider && "tasks" in florenceProvider ? florenceProvider.tasks.map((task) => <option key={task} value={task}>{task}</option>) : <option value={florenceTask}>{florenceTask}</option>}</select></label>
        </>}
        <div className="caption-ai-actions"><button className="primary" onClick={generateCandidate} disabled={generating}>{generating && !bulkProgress ? "Generating…" : "Generate Candidate"}</button><button className="secondary" onClick={generateMissing} disabled={generating}>{generating && bulkProgress ? bulkProgress : "Generate Missing"}</button><button className="secondary" onClick={() => unloadCaptionModels()} disabled={generating}>Unload AI model</button></div>
        <label className="caption-candidate-label">Generated Candidate<textarea value={aiCandidate} onChange={(event) => setAiCandidate(event.target.value)} placeholder="Generate a candidate to compare with the Working Caption above." /></label>
        <div className="caption-candidate-actions"><button className="secondary" disabled={!aiCandidate.trim()} onClick={() => navigator.clipboard?.writeText(aiCandidate)}>Copy Candidate</button><button className="primary" disabled={!aiCandidate.trim()} onClick={() => { setCaptionDraft(aiCandidate); setMessage("AI candidate copied into Working Caption. Save Caption to commit it."); }}>Use as Working Caption</button></div>
      </div>}
    </section>}

    {assets.length > 0 && <section className="panel caption-navigator stack">
      <button className="caption-browser-toggle" onClick={() => setBrowserOpen((open) => !open)} aria-expanded={browserOpen}><span>{browserOpen ? "Hide asset browser" : `Browse all ${assets.length}`}</span><span className={`caption-browser-chevron ${browserOpen ? "open" : ""}`}>⌄</span></button>
      {browserOpen && <div className="caption-browser"><div className="caption-browser-toolbar"><input placeholder="Search filenames or captions…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="muted">{visibleAssets.length} / {assets.length}</span></div><div className="caption-browser-grid">{browserAssets.map((asset) => <AssetThumb key={asset.filename} asset={asset} />)}</div></div>}
      <div className="caption-carousel-row"><button className="caption-carousel-arrow" onClick={() => navigateBy(-1)} aria-label="Previous asset">‹</button><div className="caption-carousel-strip">{carouselAssets.map((asset) => <AssetThumb key={asset.filename} asset={asset} compact />)}</div><button className="caption-carousel-arrow" onClick={() => navigateBy(1)} aria-label="Next asset">›</button></div>
      <div className="caption-carousel-position"><strong>{selectedIndex + 1}</strong> / {assets.length}<span>← → keyboard navigation</span></div>
    </section>}
  </div>;
}
