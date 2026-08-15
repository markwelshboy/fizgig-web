import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo } from "./api";
import {
  finalizeProjectArchive,
  getProjectExportOptions,
  inspectProjectArchive,
  projectArchiveUrl,
  type ArchiveComponent,
  type ArchivePreset,
  type ProjectCloneSuggestion,
  type ProjectExportOptions,
  type ProjectImportInspection,
} from "./project-transfer-api";

type IdentityMode = "preserve" | "clone";
type TransferMode = "export" | "import";

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function fallbackCloneIdentity(id: string, name: string): ProjectCloneSuggestion {
  const baseId = id.replace(/-rev\d+$/i, "");
  const baseName = name.replace(/\s+rev\d+$/i, "");
  return { id: `${baseId}-rev1`, name: `${baseName} rev1` };
}

function TriCheckbox({ checked, partial, disabled, onChange }: { checked: boolean; partial: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
}

function dependencyClosure(selected: Set<string>, components: ArchiveComponent[]) {
  const map = new Map(components.map((item) => [item.id, item]));
  const next = new Set(selected);
  next.add("project_core");
  next.add("datasets");
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...next]) {
      for (const dep of map.get(id)?.dependencies ?? []) {
        if (!next.has(dep)) { next.add(dep); changed = true; }
      }
    }
  }
  return next;
}

function removeDependents(selected: Set<string>, id: string, components: ArchiveComponent[]) {
  const next = new Set(selected);
  next.delete(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of components) {
      if (next.has(item.id) && item.dependencies.some((dep) => !next.has(dep))) {
        next.delete(item.id);
        changed = true;
      }
    }
  }
  next.add("project_core");
  next.add("datasets");
  return next;
}

export function ProjectTransferDialog({ mode, project, onClose, onImported }: {
  mode: TransferMode;
  project?: ProjectInfo | null;
  onClose: () => void;
  onImported?: (project: ProjectInfo) => void | Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [options, setOptions] = useState<ProjectExportOptions | null>(null);
  const [inspection, setInspection] = useState<ProjectImportInspection | null>(null);
  const [components, setComponents] = useState<ArchiveComponent[]>([]);
  const [presets, setPresets] = useState<ArchivePreset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState<string>("standard");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["Project", "Assets", "Run history", "Training artifacts"]));
  const [identityMode, setIdentityMode] = useState<IdentityMode>("preserve");
  const [cloneId, setCloneId] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (mode !== "export" || !project) return;
    let cancelled = false;
    setBusy(true);
    getProjectExportOptions(project.id)
      .then((value) => {
        if (cancelled) return;
        setOptions(value);
        setComponents(value.components);
        setPresets(value.presets);
        const standard = value.presets.find((item) => item.id === "standard") ?? value.presets[0];
        setSelected(dependencyClosure(new Set(standard?.components ?? []), value.components));
        setPreset(standard?.id ?? "standard");
        setIdentityMode("preserve");
        const clone = value.suggested_clone ?? fallbackCloneIdentity(project.id, project.name);
        setCloneId(clone.id);
        setCloneName(clone.name);
      })
      .catch((exc) => { if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [mode, project?.id]);

  const available = useMemo(() => new Set(components.filter((item) => item.available).map((item) => item.id)), [components]);
  const groups = useMemo(() => [...new Set(components.map((item) => item.group))], [components]);
  const estimatedBytes = useMemo(() => components.reduce((total, item) => total + (selected.has(item.id) ? item.bytes : 0), 0), [components, selected]);

  function applyPreset(nextPreset: ArchivePreset) {
    const wanted = new Set(nextPreset.components.filter((id) => available.has(id) || id === "project_core" || id === "datasets"));
    setSelected(dependencyClosure(wanted, components));
    setPreset(nextPreset.id);
    if (nextPreset.id === "clean") setIdentityMode("clone");
  }

  function toggleComponent(id: string, checked: boolean) {
    setSelected((current) => checked
      ? dependencyClosure(new Set([...current, id]), components)
      : removeDependents(current, id, components));
    setPreset("custom");
  }

  function toggleGroup(group: string, checked: boolean) {
    const ids = components.filter((item) => item.group === group && item.available && !item.required).map((item) => item.id);
    let next = new Set(selected);
    for (const id of ids) next = checked ? new Set([...next, id]) : removeDependents(next, id, components);
    setSelected(dependencyClosure(next, components));
    setPreset("custom");
  }

  async function chooseImportFile(file: File) {
    setBusy(true);
    setError("");
    try {
      const value = await inspectProjectArchive(file);
      setInspection(value);
      setComponents(value.components);
      setPresets(value.presets);
      const intended = value.components.filter((item) => item.available && item.archive_selected !== false).map((item) => item.id);
      setSelected(dependencyClosure(new Set(intended), value.components));
      const manifestPreset = typeof value.archive_manifest?.preset === "string" ? String(value.archive_manifest.preset) : "standard";
      setPreset(value.presets.some((item) => item.id === manifestPreset) ? manifestPreset : "custom");
      const clone = value.suggested_clone ?? fallbackCloneIdentity(value.project.id, value.project.name);
      setCloneId(clone.id);
      setCloneName(clone.name);
      setIdentityMode(value.collision ? "clone" : "preserve");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function beginExport() {
    if (!project) return;
    if (identityMode === "clone" && (!cloneId.trim() || !cloneName.trim())) {
      setError("A cloned export needs a new project name and ID.");
      return;
    }
    const url = projectArchiveUrl(project.id, {
      preset,
      components: [...selected],
      identityMode,
      cloneId: cloneId.trim(),
      cloneName: cloneName.trim(),
    });
    window.location.assign(url);
    onClose();
  }

  async function beginImport() {
    if (!inspection) return;
    if (inspection.collision && identityMode === "preserve") {
      setError(inspection.collision_message || `Project ID ${inspection.project.id} already exists on this pod. Import as a clone instead.`);
      return;
    }
    if (identityMode === "clone" && (!cloneId.trim() || !cloneName.trim())) {
      setError("A cloned import needs a new project name and ID.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const imported = await finalizeProjectArchive({
        token: inspection.token,
        components: [...selected],
        identityMode,
        cloneId: cloneId.trim(),
        cloneName: cloneName.trim(),
      });
      if (onImported) await onImported(imported);
      onClose();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  const basis = inspection?.project ?? project;

  return <div className="project-transfer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-transfer-dialog" role="dialog" aria-modal="true" aria-label={`${mode === "export" ? "Export" : "Import"} project`}>
      <header className="project-transfer-header">
        <button className="project-transfer-close" type="button" onClick={onClose} aria-label="Close"><i className="ti ti-x" /></button>
        <strong>{mode === "export" ? "Export project" : "Import project"}</strong>
        <span />
      </header>

      {mode === "import" && !inspection && <div className="project-transfer-file-step">
        <i className="ti ti-package-import" />
        <strong>Choose a Fizgig project archive</strong>
        <p>The archive is inspected first. Nothing is imported until you choose which components to keep.</p>
        <button type="button" className="primary" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? "Inspecting…" : "Choose archive"}</button>
        <input ref={fileInput} className="visually-hidden-file" type="file" accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/gzip,application/x-tar" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void chooseImportFile(file); }} />
      </div>}

      {(mode === "export" ? Boolean(options) : Boolean(inspection)) && <>
        <div className="project-transfer-summary">
          <div><span>Project</span><strong>{basis?.name}</strong><small>{basis?.id}</small></div>
          {inspection && <div><span>Archive</span><strong>{inspection.filename}</strong><small>{formatBytes(inspection.upload_bytes)} · {inspection.project.run_count} runs</small></div>}
        </div>

        <div className="project-transfer-presets">
          <span>Preset</span>
          <div>{presets.map((item) => <button key={item.id} type="button" className={preset === item.id ? "selected" : ""} title={item.description} onClick={() => applyPreset(item)}>{item.label}</button>)}</div>
          {preset === "custom" && <small>Custom selection</small>}
        </div>

        <div className="project-transfer-tree">
          {groups.map((group) => {
            const rows = components.filter((item) => item.group === group);
            const selectable = rows.filter((item) => item.available);
            const selectedCount = selectable.filter((item) => selected.has(item.id)).length;
            const all = selectable.length > 0 && selectedCount === selectable.length;
            const partial = selectedCount > 0 && !all;
            const expanded = expandedGroups.has(group);
            return <div className="project-transfer-group" key={group}>
              <div className="project-transfer-group-row">
                <TriCheckbox checked={all} partial={partial} onChange={(value) => toggleGroup(group, value)} />
                <button type="button" className="project-transfer-group-toggle" onClick={() => setExpandedGroups((current) => { const next = new Set(current); next.has(group) ? next.delete(group) : next.add(group); return next; })}>
                  <span>{group}</span><small>{selectedCount}/{selectable.length}</small><i className={`ti ti-chevron-${expanded ? "down" : "right"}`} />
                </button>
              </div>
              {expanded && <div className="project-transfer-children">{rows.map((item) => <label className={`project-transfer-component ${item.available ? "" : "unavailable"}`} key={item.id}>
                <input type="checkbox" checked={selected.has(item.id)} disabled={!item.available || item.required} onChange={(event) => toggleComponent(item.id, event.target.checked)} />
                <span><strong>{item.label}</strong><small>{item.description}</small></span>
                <em>{item.file_count ? `${formatBytes(item.bytes)} · ${item.file_count}` : item.available ? "required" : "not in archive"}</em>
              </label>)}</div>}
            </div>;
          })}
        </div>

        <div className="project-transfer-identity">
          <strong>Project identity</strong>
          <div className="project-transfer-identity-options">
            <label><input type="radio" checked={identityMode === "preserve"} onChange={() => setIdentityMode("preserve")} disabled={preset === "clean" || Boolean(inspection?.collision)} /> <span>Preserve existing identity</span></label>
            <label><input type="radio" checked={identityMode === "clone"} onChange={() => setIdentityMode("clone")} /> <span>Create as a clone</span></label>
          </div>
          {preset === "clean" && <small>Clean is a reusable copy with no run history, so it always receives a new project identity.</small>}
          {inspection?.collision && <div className="project-transfer-collision" role="alert"><i className="ti ti-alert-triangle" /><span>{inspection.collision_message || `Project ID ${inspection.project.id} already exists on this pod. Import as a clone to keep both.`}</span></div>}
          {identityMode === "clone" && <div className="project-transfer-clone-grid">
            <label>New project name<input value={cloneName} onChange={(event) => setCloneName(event.target.value)} /></label>
            <label>New project ID<input value={cloneId} onChange={(event) => setCloneId(event.target.value.replace(/[^A-Za-z0-9._-]+/g, "-"))} spellCheck={false} /></label>
          </div>}
        </div>
      </>}

      {error && <div className="notice error project-transfer-error">{error}</div>}

      <footer className="project-transfer-footer">
        <div><span>Projected project size</span><strong>{formatBytes(estimatedBytes)}</strong><small>archive compression varies</small></div>
        <div className="actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          {mode === "export" && options && <button type="button" className="primary" onClick={beginExport}>Export selection</button>}
          {mode === "import" && inspection && <button type="button" className="primary" disabled={busy || (inspection.collision && identityMode === "preserve")} onClick={() => void beginImport()}>{busy ? "Importing…" : "Import selection"}</button>}
        </div>
      </footer>
    </section>
  </div>;
}
