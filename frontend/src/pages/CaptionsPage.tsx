import { useMemo, useState } from "react";
import { saveCaption } from "../api";
import { useSession } from "../session";

export function CaptionsPage() {
  const { dataset, setDataset, triggerWord } = useSession();
  const [selectedName, setSelectedName] = useState(dataset?.images[0]?.filename ?? "");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const selected = dataset?.images.find((image) => image.filename === selectedName) ?? dataset?.images[0];
  const [captionDraft, setCaptionDraft] = useState(selected?.caption ?? "");

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

  async function onSave() {
    if (!dataset || !selected) return;
    setSaving(true);
    setMessage("");
    try {
      const result = await saveCaption(dataset.id, selected.filename, captionDraft);
      setDataset({
        ...dataset,
        caption_count: dataset.images.filter((image) => image.filename === selected.filename ? Boolean(result.caption) : image.has_caption).length,
        missing_caption_count: dataset.images.filter((image) => image.filename === selected.filename ? !result.caption : !image.has_caption).length,
        images: dataset.images.map((image) => image.filename === selected.filename ? { ...image, caption: result.caption, has_caption: Boolean(result.caption) } : image),
      });
      setCaptionDraft(result.caption);
      setMessage("Caption saved");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save caption");
    } finally {
      setSaving(false);
    }
  }

  if (!dataset) {
    return (
      <section className="panel hero-panel stack">
        <p className="eyebrow">Dataset required</p>
        <h1>Captions</h1>
        <p className="muted">Load a dataset on the Start page first. Captions are read directly from same-basename .txt sidecars.</p>
      </section>
    );
  }

  return (
    <div className="stack">
      <header className="page-header"><div><p className="eyebrow">Dataset</p><h1>Captions</h1><p className="muted">Review and edit the caption sidecars in {dataset.path}.</p></div><div className="actions"><button className="primary">Generate Missing</button><button className="secondary">Bulk Actions</button></div></header>
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
          {selected ? (
            <>
              <div><div className="card-title">{selected.filename}</div><div className="muted">{dataset.images.findIndex((image) => image.filename === selected.filename) + 1} / {dataset.image_count}</div></div>
              <div className="caption-preview"><img src={selected.image_url} alt={selected.filename} /></div>
              <label>Caption<textarea value={captionDraft} onChange={(event) => setCaptionDraft(event.target.value)} /></label>
              <label>Trigger word<input value={triggerWord} readOnly /></label>
              {message && <div className={message === "Caption saved" ? "notice success" : "notice error"}>{message}</div>}
              <div className="actions"><button className="secondary">Regenerate with AI</button><button className="primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save Caption"}</button></div>
              <div className="card-title">AI Captioning</div>
              <label>Provider<select defaultValue="qwen"><option value="qwen">Qwen3-VL 8B Instruct</option><option value="joy">JoyCaption</option></select></label>
              <label><input type="checkbox" defaultChecked /> Add trigger word automatically</label>
            </>
          ) : <p className="muted">No image selected.</p>}
        </section>
      </div>
    </div>
  );
}
