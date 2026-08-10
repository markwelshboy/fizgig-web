import { useEffect, useMemo, useState } from "react";
import {
  generateCaption,
  getCaptioningOptions,
  inspectDataset,
  saveCaption,
  unloadCaptionModels,
  type CaptionGenerateRequest,
  type CaptioningOptions,
} from "../api";
import { useSession } from "../session";

export function CaptionsPage() {
  const { dataset, setDataset, triggerWord } = useSession();
  const [selectedName, setSelectedName] = useState(dataset?.images[0]?.filename ?? "");
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

  const selected = dataset?.images.find((image) => image.filename === selectedName) ?? dataset?.images[0];
  const [captionDraft, setCaptionDraft] = useState(selected?.caption ?? "");

  const qwenProvider = options?.providers.find((item) => item.id === "qwen" && "tasks" in item);
  const florenceProvider = options?.providers.find((item) => item.id === "florence" && "models" in item);
  const activeQwenPreset = qwenProvider && "tasks" in qwenProvider ? qwenProvider.tasks[qwenTask] : undefined;

  useEffect(() => {
    getCaptioningOptions()
      .then((result) => {
        setOptions(result);
        const qwen = result.providers.find((item) => item.id === "qwen" && "tasks" in item);
        const florence = result.providers.find((item) => item.id === "florence" && "models" in item);
        if (qwen && "tasks" in qwen) {
          setQwenTask(qwen.default_task);
          setQwenModel(qwen.default_model);
          setQwenProcessor(qwen.default_processor);
          setQwenRevision(qwen.default_revision);
          const preset = qwen.tasks[qwen.default_task];
          if (preset) {
            setQwenInstruction(preset.instruction);
            setMaxTokens(preset.max_tokens);
          }
        }
        if (florence && "models" in florence) {
          setFlorenceModel(florence.default_model);
          setFlorenceTask(florence.default_task);
        }
      })
      .catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load captioning options"));
  }, []);

  useEffect(() => {
    if (!dataset) return;
    const stillExists = dataset.images.some((image) => image.filename === selectedName);
    if (!stillExists && dataset.images[0]) {
      setSelectedName(dataset.images[0].filename);
      setCaptionDraft(dataset.images[0].caption);
    }
  }, [dataset, selectedName]);

  const images = useMemo(() => {
    if (!dataset) return [];
    const q = query.trim().toLowerCase();
    if (!q) return dataset.images;
    return dataset.images.filter((image) => image.filename.toLowerCase().includes(q) || image.caption.toLowerCase().includes(q));
  }, [dataset, query]);

  function selectImage(filename: string) {
    const image = dataset?.images.find((item) => item.filename === filename);
    setSelectedName(filename);
    setCaptionDraft(image?.caption ?? "");
    setMessage("");
  }

  function replaceCaption(filename: string, caption: string) {
    setDataset((current) => {
      if (!current) return current;
      const nextImages = current.images.map((image) =>
        image.filename === filename ? { ...image, caption, has_caption: Boolean(caption) } : image,
      );
      const captionCount = nextImages.filter((image) => image.has_caption).length;
      return { ...current, images: nextImages, caption_count: captionCount, missing_caption_count: nextImages.length - captionCount };
    });
  }

  function generationRequest(save: boolean): CaptionGenerateRequest {
    if (provider === "qwen") {
      return {
        provider,
        model: qwenModel.trim() || undefined,
        processor: qwenProcessor.trim() || undefined,
        revision: qwenRevision.trim() || undefined,
        task: qwenTask,
        instruction: qwenInstruction.trim() || undefined,
        max_tokens: maxTokens,
        trigger_word: triggerWord,
        add_trigger_word: addTriggerWord,
        save,
      };
    }
    return { provider, model: florenceModel, task: florenceTask, max_tokens: maxTokens, trigger_word: triggerWord, add_trigger_word: addTriggerWord, save };
  }

  async function onSave() {
    if (!dataset || !selected) return;
    setSaving(true);
    setMessage("");
    try {
      const result = await saveCaption(dataset.id, selected.filename, captionDraft);
      replaceCaption(selected.filename, result.caption);
      setCaptionDraft(result.caption);
      setMessage("Caption saved");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save caption");
    } finally {
      setSaving(false);
    }
  }

  async function regenerateSelected() {
    if (!dataset || !selected) return;
    setGenerating(true);
    setMessage(`Captioning ${selected.filename}…`);
    try {
      const result = await generateCaption(dataset.id, selected.filename, generationRequest(false));
      setCaptionDraft(result.caption);
      setMessage("Generated caption is in the editor. Review it, then Save Caption.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Caption generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function generateMissing() {
    if (!dataset) return;
    const missing = dataset.images.filter((image) => !image.has_caption);
    if (!missing.length) {
      setMessage("All images already have captions.");
      return;
    }
    setGenerating(true);
    setMessage("");
    let completed = 0;
    let failed = 0;
    try {
      for (const image of missing) {
        setBulkProgress(`${completed + failed + 1} / ${missing.length} · ${image.filename}`);
        try {
          const result = await generateCaption(dataset.id, image.filename, generationRequest(true));
          replaceCaption(image.filename, result.caption);
          if (image.filename === selected?.filename) setCaptionDraft(result.caption);
          completed += 1;
        } catch (err) {
          failed += 1;
          setMessage(err instanceof Error ? err.message : `Failed on ${image.filename}`);
        }
      }
      try { setDataset(await inspectDataset(dataset.path)); } catch { /* local state is already updated */ }
      setMessage(`Generate Missing finished: ${completed} saved${failed ? `, ${failed} failed` : ""}.`);
    } finally {
      setBulkProgress("");
      setGenerating(false);
    }
  }

  function chooseQwenTask(task: string) {
    setQwenTask(task);
    if (qwenProvider && "tasks" in qwenProvider) {
      const preset = qwenProvider.tasks[task];
      if (preset) {
        setQwenInstruction(preset.instruction);
        setMaxTokens(preset.max_tokens);
      }
    }
  }

  if (!dataset) {
    return <section className="panel hero-panel stack"><p className="eyebrow">Dataset required</p><h1>Captions</h1><p className="muted">Load a dataset on the Start page first.</p></section>;
  }

  return (
    <div className="stack">
      <header className="page-header">
        <div><p className="eyebrow">Dataset</p><h1>Captions</h1><p className="muted">Review, generate, and edit caption sidecars in {dataset.path}.</p></div>
        <div className="actions">
          <button className="primary" onClick={generateMissing} disabled={generating}>{generating && bulkProgress ? bulkProgress : "Generate Missing"}</button>
          <button className="secondary" onClick={() => unloadCaptionModels()} disabled={generating}>Unload AI model</button>
        </div>
      </header>
      <div className="caption-layout">
        <section className="panel">
          <div className="toolbar"><input placeholder="Search filenames or captions…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="muted">{images.length} / {dataset.image_count}</span></div>
          <div className="thumb-grid caption-grid">
            {images.map((image) => (
              <button className={`thumb caption-thumb ${selected?.filename === image.filename ? "selected" : ""}`} key={image.filename} onClick={() => selectImage(image.filename)} title={image.filename}>
                <img src={image.image_url} alt={image.filename} />
                {!image.has_caption && <span className="missing-dot" title="Missing caption" />}
              </button>
            ))}
          </div>
        </section>
        <section className="panel stack">
          {selected ? <>
            <div><div className="card-title">{selected.filename}</div><div className="muted">{dataset.images.findIndex((image) => image.filename === selected.filename) + 1} / {dataset.image_count}</div></div>
            <div className="caption-preview"><img src={selected.image_url} alt={selected.filename} /></div>
            <label>Caption<textarea value={captionDraft} onChange={(event) => setCaptionDraft(event.target.value)} /></label>
            {message && <div className={message.includes("failed") || message.includes("requires") || message.includes("not configured") ? "notice error" : "notice success"}>{message}</div>}
            <div className="actions"><button className="secondary" onClick={regenerateSelected} disabled={generating}>{generating ? "Generating…" : "Regenerate with AI"}</button><button className="primary" onClick={onSave} disabled={saving || generating}>{saving ? "Saving…" : "Save Caption"}</button></div>

            <div className="caption-ai-section stack">
              <div className="card-title">AI Captioning</div>
              <div className="form-row">
                <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as "qwen" | "florence")}><option value="qwen">Qwen3-VL</option><option value="florence">Florence-2</option></select></label>
                <label>Max tokens<input type="number" min={16} max={1024} value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></label>
              </div>

              {provider === "qwen" ? <>
                <label>Caption model / checkpoint
                  <input value={qwenModel} onChange={(event) => setQwenModel(event.target.value)} placeholder="Qwen/Qwen3-VL-8B-Instruct or /workspace/models/my-qwen" />
                  <span className="muted">Hugging Face repo ID or an HF-compatible local model directory. This is independent of the Krea/Klein training encoder.</span>
                </label>
                <div className="form-row">
                  <label>Processor override <span className="muted">Optional</span><input value={qwenProcessor} onChange={(event) => setQwenProcessor(event.target.value)} placeholder="Leave blank to use the model source" /></label>
                  <label>Revision <span className="muted">Optional</span><input value={qwenRevision} onChange={(event) => setQwenRevision(event.target.value)} placeholder="branch, tag, or commit" /></label>
                </div>
                <label>Caption preset<select value={qwenTask} onChange={(event) => chooseQwenTask(event.target.value)}>{qwenProvider && "tasks" in qwenProvider ? Object.entries(qwenProvider.tasks).map(([key, task]) => <option key={key} value={key}>{task.label}</option>) : <option value="training">Training caption (viewpoint-aware)</option>}</select></label>
                <label>Captioning instruction — editable prompt override<textarea className="instruction-editor" value={qwenInstruction} onChange={(event) => setQwenInstruction(event.target.value)} /></label>
                <div className="prompt-actions"><span className="muted">The caption VLM is completely separate from the model's training text encoder.</span><button className="secondary" onClick={() => activeQwenPreset && setQwenInstruction(activeQwenPreset.instruction)} disabled={!activeQwenPreset}>Restore preset</button></div>
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
