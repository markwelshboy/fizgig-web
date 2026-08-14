import { useEffect, useMemo, useState } from "react";
import {
  getCaptionMethodologies,
  saveCaptionMethodologies,
  type CaptionMethodology,
  type CaptionMethodologyPayload,
  type CaptionMethodologyValidation,
} from "../caption-methodologies-api";
import { getCaptionTemplate } from "../caption-template-api";
import { useSession } from "../session";

const EXAMPLE_VARIABLES: Record<string, string> = {
  TRIGGER: "sH1Vx",
  GENDER_GRAMMAR: "feminine",
  SUBJECT_PRONOUN: "she",
  OBJECT_PRONOUN: "her",
  POSSESSIVE_PRONOUN: "her",
  REFLEXIVE_PRONOUN: "herself",
  PROTECTED_TRAITS: "none configured",
};

function cloneMethods(methods: CaptionMethodology[]) {
  return Object.fromEntries(methods.map((method) => [method.id, {
    ...method,
    validation: method.validation ? { ...method.validation } : null,
  }])) as Record<string, CaptionMethodology>;
}

function renderInstruction(instruction: string, variables: Record<string, string>) {
  return instruction.replace(/\[([A-Z][A-Z0-9_]*)\]/g, (whole, key) => variables[key] ?? whole);
}

export function CaptionMethodologySettings() {
  const { project, revision } = useSession();
  const [saved, setSaved] = useState<CaptionMethodologyPayload | null>(null);
  const [customs, setCustoms] = useState<Record<string, CaptionMethodology>>({});
  const [ladder, setLadder] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("custom1");
  const [projectVariables, setProjectVariables] = useState<Record<string, string> | null>(null);
  const [renderedOpen, setRenderedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    getCaptionMethodologies().then((value) => {
      if (cancelled) return;
      setSaved(value);
      setCustoms(cloneMethods(value.customs));
      setLadder([...value.rewrite_ladder]);
    }).catch((err) => {
      if (!cancelled) setMessage(err instanceof Error ? err.message : "Unable to load caption methodologies");
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!project || !revision) {
      setProjectVariables(null);
      return;
    }
    let cancelled = false;
    getCaptionTemplate(project.id, revision.id).then((value) => {
      if (!cancelled) setProjectVariables(value.variables);
    }).catch(() => {
      if (!cancelled) setProjectVariables(null);
    });
    return () => { cancelled = true; };
  }, [project?.id, revision?.id, project?.trigger_word]);

  const selected = customs[selectedId];
  const allMethods = useMemo(() => saved ? [...saved.builtins, ...Object.values(customs)] : [], [saved, customs]);
  const methodMap = useMemo(() => new Map(allMethods.map((method) => [method.id, method])), [allMethods]);
  const dirty = useMemo(() => {
    if (!saved) return false;
    const current = {
      customs: Object.fromEntries(saved.customs.map((method) => [method.id, method])),
      ladder: saved.rewrite_ladder,
    };
    const draft = { customs, ladder };
    return JSON.stringify(current) !== JSON.stringify(draft);
  }, [saved, customs, ladder]);

  function patchSelected<K extends keyof CaptionMethodology>(key: K, value: CaptionMethodology[K]) {
    setCustoms((current) => ({
      ...current,
      [selectedId]: { ...current[selectedId], [key]: value },
    }));
  }

  function patchValidation<K extends keyof CaptionMethodologyValidation>(key: K, value: CaptionMethodologyValidation[K]) {
    if (!selected?.validation) return;
    patchSelected("validation", { ...selected.validation, [key]: value });
  }

  async function save() {
    if (!saved || !dirty) return;
    setBusy(true); setMessage("");
    try {
      const payload = await saveCaptionMethodologies({
        customs: Object.fromEntries(Object.entries(customs).map(([id, method]) => [id, {
          name: method.name,
          description: method.description,
          instruction: method.instruction,
          max_tokens: method.max_tokens,
          validation: method.validation,
        }])),
        rewrite_ladder: ladder,
      });
      setSaved(payload);
      setCustoms(cloneMethods(payload.customs));
      setLadder([...payload.rewrite_ladder]);
      setMessage("Caption methodologies and rewrite ladder saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save caption methodologies");
    } finally { setBusy(false); }
  }

  if (!saved || !selected) {
    return <section className="panel methodology-settings-panel"><div className="muted">{message || "Loading caption methodologies…"}</div></section>;
  }

  const variables = projectVariables ?? EXAMPLE_VARIABLES;
  const rendered = renderInstruction(selected.instruction, variables);
  const baselineOptions = saved.builtins;

  return <section className="panel stack methodology-settings-panel" id="caption-methodologies">
    <div className="methodology-heading">
      <div>
        <p className="eyebrow">Caption Methodologies</p>
        <div className="card-title">Baseline controls + three custom experiments</div>
        <p className="muted">Built-in Qwen tasks are deliberately left unchanged so they remain valid controls. Custom 1–3 are reusable prompt methodologies with project variables and optional output validation.</p>
      </div>
      <button className="primary" type="button" onClick={save} disabled={busy || !dirty}>{busy ? "Saving…" : "Save Methodologies"}</button>
    </div>

    <div className="methodology-baselines">
      <strong>Built-in baselines</strong>
      <div className="methodology-chip-row">{baselineOptions.map((method) => <span key={method.id} className="methodology-baseline-chip" title={method.instruction}>{method.name}<small>unchanged Qwen output</small></span>)}</div>
      <p className="muted">When “Add trigger” is enabled on Captions, built-ins use the existing conventional prepend behavior. They do not inherit Custom validation or trigger-as-subject rules.</p>
    </div>

    <div className="methodology-custom-layout">
      <div className="methodology-slot-list">
        {saved.customs.map((method, index) => {
          const draft = customs[method.id];
          return <button key={method.id} type="button" className={`methodology-slot ${selectedId === method.id ? "selected" : ""}`} onClick={() => setSelectedId(method.id)}>
            <span>Custom {index + 1}</span><strong>{draft.name || method.id}</strong><small>{draft.instruction.trim() ? `rev ${draft.revision} · configured` : "not configured"}</small>
          </button>;
        })}
      </div>

      <div className="methodology-editor stack">
        <div className="form-row">
          <label>Name<input value={selected.name} onChange={(event) => patchSelected("name", event.target.value)} /></label>
          <label>Max tokens<input type="number" min={16} max={1024} value={selected.max_tokens} onChange={(event) => patchSelected("max_tokens", Math.max(16, Math.min(1024, Number(event.target.value) || 16)))} /></label>
        </div>
        <label>Description<input value={selected.description} onChange={(event) => patchSelected("description", event.target.value)} placeholder="What this methodology is trying to do" /></label>
        <label>VLM instruction<textarea className="methodology-prompt-editor" value={selected.instruction} onChange={(event) => patchSelected("instruction", event.target.value)} spellCheck={false} placeholder="Enter a custom Qwen instruction. Variables such as [TRIGGER] are substituted before generation." /></label>

        <div className="methodology-variable-row">
          {saved.variables.map((name) => <span key={name} title={variables[name] ?? ""}><b>[{name}]</b>{variables[name] ? ` ${variables[name]}` : ""}</span>)}
        </div>
        <p className="muted">{projectVariables ? `Preview variables are resolved from ${project?.name}.` : "No project is open, so the preview uses example identity variables."}</p>

        {selected.validation && <div className="methodology-validation-grid">
          <label className="inline-check"><input type="checkbox" checked={selected.validation.require_trigger_first} onChange={(event) => patchValidation("require_trigger_first", event.target.checked)} /> Trigger must be first</label>
          <label className="inline-check"><input type="checkbox" checked={selected.validation.require_single_trigger} onChange={(event) => patchValidation("require_single_trigger", event.target.checked)} /> Trigger exactly once</label>
          <label className="inline-check"><input type="checkbox" checked={selected.validation.reject_detached_trailing_trigger} onChange={(event) => patchValidation("reject_detached_trailing_trigger", event.target.checked)} /> Reject trailing trigger</label>
          <label className="inline-check"><input type="checkbox" checked={selected.validation.reject_generic_subject_after_trigger} onChange={(event) => patchValidation("reject_generic_subject_after_trigger", event.target.checked)} /> Reject “trigger, a woman/person…”</label>
          <label className="inline-check"><input type="checkbox" checked={selected.validation.retry_on_failure} onChange={(event) => patchValidation("retry_on_failure", event.target.checked)} /> Retry invalid structure</label>
          <label>Max attempts<input type="number" min={1} max={5} disabled={!selected.validation.retry_on_failure} value={selected.validation.max_attempts} onChange={(event) => patchValidation("max_attempts", Math.max(1, Math.min(5, Number(event.target.value) || 1)))} /></label>
        </div>}

        <button className="methodology-preview-toggle" type="button" onClick={() => setRenderedOpen((open) => !open)}><span><strong>Rendered Prompt Preview</strong><small>what Qwen receives after variable substitution</small></span><span>{renderedOpen ? "⌃" : "⌄"}</span></button>
        {renderedOpen && <pre className="methodology-rendered-prompt">{rendered || "This custom methodology has no prompt yet."}</pre>}
      </div>
    </div>

    <div className="methodology-ladder stack">
      <div><div className="card-title">Automatic Caption Resolution</div><p className="muted">Choose the exact methodology used for each escalation stage after an image is confirmed stuck. Per-image Hold/Never policy bypasses this ladder.</p></div>
      <div className="methodology-ladder-grid">{[0, 1, 2].map((index) => <label key={index}>Stage {index + 1} Rewrite<select value={ladder[index] ?? ""} onChange={(event) => setLadder((current) => current.map((value, i) => i === index ? event.target.value : value))}>
        <optgroup label="Built-in baselines">{saved.builtins.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</optgroup>
        <optgroup label="Custom methodologies">{Object.values(customs).map((method) => <option key={method.id} value={method.id} disabled={!method.instruction.trim()}>{method.name}{method.instruction.trim() ? "" : " (not configured)"}</option>)}</optgroup>
      </select><small>{methodMap.get(ladder[index])?.description || "Select a methodology"}</small></label>)}</div>
      <div className="methodology-ladder-flow">{ladder.map((id, index) => <span key={`${id}-${index}`}><b>{index + 1}</b>{methodMap.get(id)?.name ?? id}</span>)}</div>
    </div>

    {message && <div className={message.toLowerCase().includes("unable") || message.toLowerCase().includes("failed") ? "notice error" : "notice success"}>{message}</div>}
  </section>;
}
