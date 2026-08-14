import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getCaptioningOptions,
  getProjectRevision,
  getProjectRevisionPolicy,
  getTrainingFilenames,
  updateCaptionValidationPolicy,
  updateProjectAssetPolicy,
  updateProjectCaption,
  unloadCaptionModels,
  type AssetTrainingPolicy,
  type AutoRecaptionPolicy,
  type CaptioningOptions,
  type ProjectRevisionPolicy,
  type TrainingFilenameState,
} from "../api";
import { getCaptionMethodologies, type CaptionMethodologyPayload } from "../caption-methodologies-api";
import { getCaptionTemplate, updateCaptionTemplate } from "../caption-template-api";
import {
  getCaptionRuntimeStatus,
  getCaptionStatus,
  spellcheckProjectCaption,
  updateProjectTriggerWord,
  type CaptionRuntimeStatus,
  type CaptionSpellcheckResult,
  type CaptionStatusState,
} from "../caption-runtime-api";
import {
  generateProjectAssetCaption,
  preparedProjectAssetUrl,
  type ProjectCaptionGenerateRequest,
  type ProjectCaptionGenerateResult,
} from "../project-captioning-api";
import { useSession } from "../session";

const CAROUSEL_SIZE = 5;
const CAROUSEL_RADIUS = Math.floor(CAROUSEL_SIZE / 2);

function parsePolicyList(value: string) {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
}

function sameList(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function modelIdentity(value: string, fallback: string) {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized) return fallback;
  if (!normalized.startsWith("/") && normalized.split("/").filter(Boolean).length === 2) return normalized;
  const leaf = normalized.split("/").filter(Boolean).pop() || fallback;
  return leaf.includes("--") ? leaf.replace("--", "/") : leaf;
}

function providerLabel(provider: "qwen" | "florence") {
  return provider === "qwen" ? "Qwen3-VL" : "Florence-2";
}

function replaceFirstWord(text: string, word: string, replacement: string) {
  if (!word || !replacement) return text;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b`, "i"), replacement);
}

function SpellingSummary({ result, onReplace }: { result: CaptionSpellcheckResult | null; onReplace?: (word: string, replacement: string) => void }) {
  if (!result?.enabled || !result.issues.length) return null;
  return <div className="caption-spelling-summary" role="status">
    <span className="caption-spelling-label">Possible spelling:</span>
    {result.issues.map((issue) => {
      const suggestion = issue.suggestions[0];
      return suggestion && onReplace
        ? <button key={`${issue.word}-${suggestion}`} type="button" className="caption-spelling-chip" title={`Replace ${issue.word} with ${suggestion}`} onClick={() => onReplace(issue.word, suggestion)}>{issue.word} → {suggestion}</button>
        : <span key={issue.word} className="caption-spelling-chip static">{issue.word}{suggestion ? ` → ${suggestion}` : ""}</span>;
    })}
  </div>;
}

export function CaptionsPage() {
  const navigate = useNavigate();
  const { project, setProject, revision, setRevision, run, triggerWord, setTriggerWord } = useSession();
  const initialAsset = revision?.assets.find((asset) => asset.included !== false);
  const [selectedName, setSelectedName] = useState(initialAsset?.filename ?? "");
  const [query, setQuery] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [advancedAiOpen, setAdvancedAiOpen] = useState(false);
  const [aiCandidate, setAiCandidate] = useState("");
  const [aiCandidateMetadata, setAiCandidateMetadata] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [unloading, setUnloading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");
  const [message, setMessage] = useState("");
  const [options, setOptions] = useState<CaptioningOptions | null>(null);
  const [methodologies, setMethodologies] = useState<CaptionMethodologyPayload | null>(null);
  const [methodologyId, setMethodologyId] = useState("builtin:training");
  const [provider, setProvider] = useState<"qwen" | "florence">("qwen");
  const [qwenModel, setQwenModel] = useState("");
  const [qwenProcessor, setQwenProcessor] = useState("");
  const [qwenRevision, setQwenRevision] = useState("");
  const [florenceModel, setFlorenceModel] = useState("MiaoshouAI/Florence-2-base-PromptGen");
  const [florenceTask, setFlorenceTask] = useState("<DETAILED_CAPTION>");
  const [maxTokens, setMaxTokens] = useState(120);
  const [addTriggerWord, setAddTriggerWord] = useState(true);
  const [subjectGrammar, setSubjectGrammar] = useState("feminine");
  const [grammarProfiles, setGrammarProfiles] = useState<Record<string, { label: string }>>({});
  const [grammarSaving, setGrammarSaving] = useState(false);
  const [policy, setPolicy] = useState<ProjectRevisionPolicy | null>(null);
  const [trainingNames, setTrainingNames] = useState<TrainingFilenameState | null>(null);
  const [captionRuntime, setCaptionRuntime] = useState<CaptionRuntimeStatus | null>(null);
  const [captionStatuses, setCaptionStatuses] = useState<CaptionStatusState | null>(null);
  const [workingSpelling, setWorkingSpelling] = useState<CaptionSpellcheckResult | null>(null);
  const [candidateSpelling, setCandidateSpelling] = useState<CaptionSpellcheckResult | null>(null);
  const [triggerDraft, setTriggerDraft] = useState(project?.trigger_word ?? triggerWord);
  const [triggerSaving, setTriggerSaving] = useState(false);
  const [protectedDraft, setProtectedDraft] = useState("");
  const [acceptedWordsDraft, setAcceptedWordsDraft] = useState("");
  const [spellcheckEnabled, setSpellcheckEnabled] = useState(true);
  const [policySaving, setPolicySaving] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(initialAsset?.caption ?? "");
  const [draftSource, setDraftSource] = useState<"manual" | "ai">("manual");
  const [draftAiMetadata, setDraftAiMetadata] = useState<Record<string, unknown> | null>(null);

  const assets = (revision?.assets ?? []).filter((asset) => asset.included !== false);
  const selectedAsset = assets.find((asset) => asset.filename === selectedName) ?? assets[0];
  const selectedIndex = selectedAsset ? assets.findIndex((asset) => asset.filename === selectedAsset.filename) : -1;
  const revisionAssetVersion = revision?.assets.map((asset) => `${asset.id ?? asset.filename}:${asset.included === false ? 0 : 1}:${asset.caption_sha256 ?? ""}`).join("|") ?? "";
  const missingCount = assets.filter((asset) => !asset.caption.trim()).length;
  const batchGeneratesAll = missingCount === 0 && assets.length > 0;
  const modelLoaded = Boolean(captionRuntime?.loaded.length);
  const triggerPending = triggerDraft.trim() !== triggerWord.trim();
  const triggerConfigured = Boolean(triggerWord.trim());
  const qwenMethods = methodologies ? [...methodologies.builtins, ...methodologies.customs] : [];
  const activeMethodology = qwenMethods.find((method) => method.id === methodologyId);
  const customMethodology = provider === "qwen" && activeMethodology?.kind === "custom";
  const customTriggerRules = customMethodology && activeMethodology?.validation ? (
    activeMethodology.validation.require_exact_trigger
    || activeMethodology.validation.require_trigger_first
    || activeMethodology.validation.require_single_trigger
    || activeMethodology.validation.reject_detached_trailing_trigger
    || activeMethodology.validation.reject_generic_subject_after_trigger
  ) : false;
  const customPromptUsesTrigger = Boolean(customMethodology && activeMethodology?.instruction.includes("[TRIGGER]"));
  const customNeedsTrigger = Boolean(customMethodology && (customTriggerRules || customPromptUsesTrigger));
  const generationNeedsTrigger = provider === "qwen" && customMethodology ? customNeedsTrigger : addTriggerWord;
  const generationBlockedByTrigger = Boolean(generationNeedsTrigger && (triggerPending || !triggerConfigured));

  const trainingNameMaps = useMemo(() => {
    const byId = new Map<string, string>();
    const byProjectFilename = new Map<string, string>();
    for (const row of trainingNames?.rows ?? []) {
      if (row.asset_id) byId.set(row.asset_id, row.training_filename);
      byProjectFilename.set(row.project_filename, row.training_filename);
    }
    return { byId, byProjectFilename };
  }, [trainingNames]);

  function displayName(asset: (typeof assets)[number]) {
    return (asset.id ? trainingNameMaps.byId.get(asset.id) : undefined)
      ?? trainingNameMaps.byProjectFilename.get(asset.filename)
      ?? asset.filename;
  }

  function displayTitle(asset: (typeof assets)[number]) {
    const trainingName = displayName(asset);
    return trainingName === asset.filename ? asset.filename : `Training: ${trainingName}\nProject: ${asset.filename}`;
  }

  const selectedDisplayName = selectedAsset ? displayName(selectedAsset) : "";
  const qwenProvider = options?.providers.find((item) => item.id === "qwen" && "tasks" in item);
  const florenceProvider = options?.providers.find((item) => item.id === "florence" && "models" in item);
  const qwenCaptionerLabel = `Qwen3-VL — ${modelIdentity(qwenModel || (qwenProvider && "default_model" in qwenProvider ? qwenProvider.default_model : ""), "Qwen3-VL")}`;
  const florenceCaptionerLabel = `Florence-2 — ${modelIdentity(florenceModel, "Florence-2")}`;
  const selectedPolicy = selectedAsset
    ? { training_policy: "automatic" as AssetTrainingPolicy, auto_recaption_policy: "automatic" as AutoRecaptionPolicy, ...(policy?.assets[selectedAsset.filename] ?? {}) }
    : null;
  const captionChanged = Boolean(selectedAsset && captionDraft !== selectedAsset.caption);
  const protectedMatches = useMemo(() => {
    const haystack = captionDraft.toLowerCase();
    return (policy?.caption_validation.protected_phrases ?? []).filter((phrase) => phrase && haystack.includes(phrase.toLowerCase()));
  }, [captionDraft, policy]);
  const candidateProtectedMatches = useMemo(() => {
    const haystack = aiCandidate.toLowerCase();
    return (policy?.caption_validation.protected_phrases ?? []).filter((phrase) => phrase && haystack.includes(phrase.toLowerCase()));
  }, [aiCandidate, policy]);
  const policyDirty = useMemo(() => {
    if (!policy) return false;
    return !sameList(parsePolicyList(protectedDraft), policy.caption_validation.protected_phrases)
      || !sameList(parsePolicyList(acceptedWordsDraft), policy.caption_validation.accepted_words)
      || spellcheckEnabled !== policy.caption_validation.spellcheck_enabled;
  }, [policy, protectedDraft, acceptedWordsDraft, spellcheckEnabled]);

  async function refreshCaptionRuntime() {
    try { setCaptionRuntime(await getCaptionRuntimeStatus()); }
    catch { setCaptionRuntime(null); }
  }

  async function refreshCaptionStatuses() {
    if (!project || !revision) return;
    try { setCaptionStatuses(await getCaptionStatus(project.id, revision.id)); }
    catch { setCaptionStatuses(null); }
  }

  function markProviderLoaded(loadedProvider: "qwen" | "florence") {
    setCaptionRuntime((current) => {
      const loaded = new Set(current?.loaded ?? []);
      loaded.add(loadedProvider);
      return {
        loaded: [...loaded],
        qwen_model: loadedProvider === "qwen" ? qwenModel || current?.qwen_model || null : current?.qwen_model ?? null,
        florence_model: loadedProvider === "florence" ? florenceModel || current?.florence_model || null : current?.florence_model ?? null,
      };
    });
  }

  useEffect(() => {
    Promise.all([getCaptioningOptions(), getCaptionMethodologies()]).then(([result, methodResult]) => {
      setOptions(result);
      setMethodologies(methodResult);
      const qwen = result.providers.find((item) => item.id === "qwen" && "tasks" in item);
      const florence = result.providers.find((item) => item.id === "florence" && "models" in item);
      if (qwen && "tasks" in qwen) {
        setQwenModel(qwen.default_model);
        setQwenProcessor(qwen.default_processor);
        setQwenRevision(qwen.default_revision);
      }
      const defaultMethod = methodResult.builtins.find((method) => method.id === "builtin:training") ?? methodResult.builtins[0] ?? methodResult.customs[0];
      if (defaultMethod) {
        setMethodologyId(defaultMethod.id);
        setMaxTokens(defaultMethod.max_tokens);
      }
      if (florence && "models" in florence) {
        setFlorenceModel(florence.default_model);
        setFlorenceTask(florence.default_task);
      }
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load captioning options"));
    void refreshCaptionRuntime();
  }, []);

  useEffect(() => {
    const savedTrigger = project?.trigger_word ?? "";
    setTriggerWord(savedTrigger);
    setTriggerDraft(savedTrigger);
  }, [project?.id, project?.trigger_word, setTriggerWord]);

  useEffect(() => {
    if (!project || !revision) return;
    Promise.all([
      getProjectRevisionPolicy(project.id, revision.id),
      getCaptionTemplate(project.id, revision.id),
    ]).then(([result, identity]) => {
      setPolicy(result);
      setProtectedDraft(result.caption_validation.protected_phrases.join("\n"));
      setAcceptedWordsDraft(result.caption_validation.accepted_words.join("\n"));
      setSpellcheckEnabled(result.caption_validation.spellcheck_enabled);
      setSubjectGrammar(identity.state.grammar_profile);
      setGrammarProfiles(identity.grammar_profiles);
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load caption policy"));
  }, [project?.id, revision?.id]);

  useEffect(() => {
    if (!project || !revision) { setTrainingNames(null); return; }
    getTrainingFilenames(project.id, revision.id).then(setTrainingNames).catch(() => setTrainingNames(null));
    void refreshCaptionStatuses();
  }, [project?.id, revision?.id, revisionAssetVersion]);

  useEffect(() => {
    if (!selectedAsset && assets[0]) {
      setSelectedName(assets[0].filename);
      setCaptionDraft(assets[0].caption);
      setAiCandidate("");
      setAiCandidateMetadata(null);
      setDraftSource("manual");
      setDraftAiMetadata(null);
    }
  }, [assets, selectedAsset]);

  useEffect(() => {
    if (!project || !revision || !spellcheckEnabled) {
      setWorkingSpelling(null);
      setCandidateSpelling(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      Promise.all([
        spellcheckProjectCaption(project.id, revision.id, captionDraft),
        aiCandidate.trim() ? spellcheckProjectCaption(project.id, revision.id, aiCandidate) : Promise.resolve({ enabled: true, issues: [] }),
      ]).then(([working, candidate]) => {
        if (!cancelled) { setWorkingSpelling(working); setCandidateSpelling(candidate); }
      }).catch(() => {
        if (!cancelled) { setWorkingSpelling(null); setCandidateSpelling(null); }
      });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [project?.id, revision?.id, captionDraft, aiCandidate, spellcheckEnabled, policy?.updated_at]);

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
    return assets.filter((asset) => displayName(asset).toLowerCase().includes(q) || asset.filename.toLowerCase().includes(q) || asset.caption.toLowerCase().includes(q));
  }, [assets, query, trainingNameMaps]);

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

  function imageUrl(filename: string) {
    if (!project || !revision) return "";
    return preparedProjectAssetUrl(project.id, revision.id, filename);
  }

  function selectImage(filename: string) {
    const asset = assets.find((item) => item.filename === filename);
    setSelectedName(filename);
    setCaptionDraft(asset?.caption ?? "");
    setAiCandidate("");
    setAiCandidateMetadata(null);
    setDraftSource("manual");
    setDraftAiMetadata(null);
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
    const diagnostic = captionStatuses?.statuses[asset.filename];
    const missing = !asset.caption.trim();
    return {
      missing,
      diagnosticsAvailable: Boolean(diagnostic),
      captionSource: diagnostic?.source ?? (missing ? "missing" : null),
      protectedCount: diagnostic?.protected_matches.length ?? 0,
      spellingCount: diagnostic?.spelling_issue_count ?? 0,
      triggerState: diagnostic?.trigger_state ?? "not_configured",
      triggerWord: diagnostic?.trigger_word ?? triggerWord,
      alwaysTrain: itemPolicy.training_policy === "always_train",
      held: itemPolicy.auto_recaption_policy === "hold",
      locked: itemPolicy.auto_recaption_policy === "never",
    };
  }

  function AssetStatusOverlay({ asset, full = false }: { asset: (typeof assets)[number]; full?: boolean }) {
    const status = assetStatus(asset);
    const sourceBadge = !status.missing && status.captionSource === "ai"
      ? { text: "AI", title: "Saved caption generated by AI", className: "ai" }
      : !status.missing && status.captionSource === "manual"
        ? { text: "✎", title: "Saved caption manually edited", className: "manual" }
        : !status.missing && (status.captionSource === "source" || status.captionSource === "saved")
          ? { text: "S", title: status.captionSource === "source" ? "Caption imported with the source asset" : "Saved caption", className: "saved" }
          : null;
    const triggerProblem = !status.missing && (status.triggerState === "missing" || status.triggerState === "case_mismatch");
    const triggerTitle = status.triggerState === "case_mismatch"
      ? `Project trigger ${status.triggerWord} is present with different capitalization`
      : `Project trigger ${status.triggerWord} is missing from this caption`;

    return <>
      <span className={`caption-nav-badges ${full ? "caption-full-status-badges" : ""}`}>
        {status.missing && <span className="caption-status-dot missing" title="Missing caption" />}
        {!status.missing && !status.diagnosticsAvailable && <span className="caption-status-glyph unknown" title="Caption diagnostics unavailable">?</span>}
        {sourceBadge && <span className={`caption-status-glyph ${sourceBadge.className}`} title={sourceBadge.title}>{sourceBadge.text}</span>}
        {triggerProblem && <span className="caption-status-glyph trigger" title={triggerTitle}>T!</span>}
        {status.protectedCount > 0 && <span className="caption-status-glyph protected" title={`${status.protectedCount} protected phrase match${status.protectedCount === 1 ? "" : "es"}`}>P</span>}
        {status.spellingCount > 0 && <span className="caption-status-glyph spelling" title={`${status.spellingCount} possible spelling issue${status.spellingCount === 1 ? "" : "s"}`}>!</span>}
      </span>
      <span className={`caption-nav-policy-badges ${full ? "caption-full-policy-badges" : ""}`}>
        {status.alwaysTrain && <span className="caption-status-chip" title="Always Train">Train</span>}
        {status.held && <span className="caption-status-chip" title="Auto-recaption held">Hold</span>}
        {status.locked && <span className="caption-status-chip" title="Auto-recaption disabled">Lock</span>}
      </span>
    </>;
  }

  async function refreshRevision() {
    if (!project || !revision) return;
    setRevision(await getProjectRevision(project.id, revision.id));
  }

  function chooseMethodology(nextId: string) {
    setMethodologyId(nextId);
    const method = qwenMethods.find((item) => item.id === nextId);
    if (method) setMaxTokens(method.max_tokens);
    setAiCandidate("");
    setAiCandidateMetadata(null);
  }

  function generationRequest(): ProjectCaptionGenerateRequest {
    const shouldAddTrigger = addTriggerWord && Boolean(triggerWord.trim());
    if (provider === "qwen") {
      return {
        provider,
        model: qwenModel.trim() || undefined,
        processor: qwenProcessor.trim() || undefined,
        revision: qwenRevision.trim() || undefined,
        methodology_id: methodologyId,
        max_tokens: maxTokens,
        trigger_word: triggerWord,
        add_trigger_word: activeMethodology?.kind === "custom" ? false : shouldAddTrigger,
        save: false,
      };
    }
    return { provider, model: florenceModel, task: florenceTask, max_tokens: maxTokens, trigger_word: triggerWord, add_trigger_word: shouldAddTrigger, save: false };
  }

  function captionMetadata(result?: ProjectCaptionGenerateResult) {
    const trigger_word_added = provider !== "qwen" || activeMethodology?.kind === "builtin"
      ? addTriggerWord && Boolean(triggerWord.trim())
      : false;
    return provider === "qwen"
      ? {
          source: "ai",
          provider,
          model: qwenModel,
          processor: qwenProcessor,
          model_revision: qwenRevision,
          methodology_id: methodologyId,
          methodology: result?.methodology ?? activeMethodology ?? null,
          generation_attempts: result?.attempts ?? 1,
          methodology_validation: result?.validation ?? null,
          max_tokens: maxTokens,
          trigger_word: triggerWord,
          trigger_word_added,
          trigger_binding: activeMethodology?.kind === "custom" ? "methodology_defined" : "baseline_legacy",
          prepared_asset: true,
        }
      : { source: "ai", provider, model: florenceModel, task: florenceTask, max_tokens: maxTokens, trigger_word: triggerWord, trigger_word_added, prepared_asset: true };
  }

  async function saveCanonical(filename: string, caption: string, reason: string, metadata: Record<string, unknown>) {
    if (!project || !revision) throw new Error("Open a project revision first");
    const result = await updateProjectCaption(project.id, revision.id, filename, { caption, reason, metadata, materialize: Boolean(run), run_id: run?.id });
    await refreshRevision();
    await refreshCaptionStatuses();
    return result;
  }

  async function saveTriggerWord() {
    if (!project || !triggerPending) return;
    setTriggerSaving(true); setMessage("");
    try {
      const updated = await updateProjectTriggerWord(project.id, triggerDraft);
      setProject(updated);
      setTriggerWord(updated.trigger_word || "");
      setTriggerDraft(updated.trigger_word || "");
      await refreshCaptionStatuses();
      setMessage("Trigger word saved to the project. Existing saved captions were not rewritten.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save trigger word"); }
    finally { setTriggerSaving(false); }
  }

  async function saveSubjectGrammar(next: string) {
    if (!project || !revision || next === subjectGrammar) return;
    setGrammarSaving(true); setMessage("");
    try {
      const updated = await updateCaptionTemplate(project.id, revision.id, { grammar_profile: next });
      setSubjectGrammar(updated.state.grammar_profile);
      setGrammarProfiles(updated.grammar_profiles);
      setMessage("Subject grammar saved for custom caption methodologies.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save subject grammar"); }
    finally { setGrammarSaving(false); }
  }

  async function onSave() {
    if (!selectedAsset) return;
    setSaving(true); setMessage("");
    try {
      const aiSave = draftSource === "ai";
      const result = await saveCanonical(
        selectedAsset.filename,
        captionDraft,
        aiSave ? "ai_candidate_accepted" : "manual_edit",
        aiSave ? (draftAiMetadata ?? { source: "ai", page: "captions" }) : { source: "manual", page: "captions" },
      );
      setCaptionDraft(result.caption);
      setDraftSource("manual");
      setDraftAiMetadata(null);
      setMessage(result.changed ? "Caption saved to project history" : "Caption unchanged");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save caption"); }
    finally { setSaving(false); }
  }

  async function generateCandidate() {
    if (!project || !revision || !selectedAsset || generationBlockedByTrigger) return;
    setGenerating(true); setMessage(`Generating candidate for ${displayName(selectedAsset)}…`);
    try {
      const result = await generateProjectAssetCaption(project.id, revision.id, selectedAsset.filename, generationRequest());
      setAiCandidate(result.caption);
      setAiCandidateMetadata(captionMetadata(result));
      markProviderLoaded(provider);
      setMessage("AI candidate generated. Your Working Caption has not been changed.");
    } catch (err) { setMessage(err instanceof Error ? err.message : "Caption generation failed"); }
    finally { setGenerating(false); }
  }

  async function generateMissing() {
    if (!project || !revision || generationBlockedByTrigger || !assets.length) return;
    const missing = assets.filter((asset) => !asset.caption.trim());
    const generateAll = missing.length === 0;
    const targets = generateAll ? assets : missing;
    const actionLabel = generateAll ? "Generate All" : "Generate Missing";
    setGenerating(true); setMessage("");
    let completed = 0; let failed = 0;
    try {
      for (const asset of targets) {
        setBulkProgress(`${completed + failed + 1} / ${targets.length} · ${displayName(asset)}`);
        try {
          const result = await generateProjectAssetCaption(project.id, revision.id, asset.filename, generationRequest());
          markProviderLoaded(provider);
          await saveCanonical(asset.filename, result.caption, generateAll ? "ai_generate_all" : "ai_generate_missing", captionMetadata(result));
          if (asset.filename === selectedAsset?.filename) setCaptionDraft(result.caption);
          completed += 1;
        } catch (err) {
          failed += 1;
          setMessage(err instanceof Error ? err.message : `Failed on ${displayName(asset)}`);
        }
      }
      await refreshRevision();
      await refreshCaptionStatuses();
      setMessage(`${actionLabel} finished: ${completed} committed to project history${failed ? `, ${failed} failed` : ""}.`);
    } finally { setBulkProgress(""); setGenerating(false); }
  }

  async function unloadAiModel() {
    if (unloading || generating || !modelLoaded) return;
    setUnloading(true); setMessage("");
    try {
      const result = await unloadCaptionModels();
      setCaptionRuntime((current) => {
        const removed = new Set(result.unloaded);
        return {
          loaded: (current?.loaded ?? []).filter((item) => !removed.has(item)),
          qwen_model: removed.has("qwen") ? null : current?.qwen_model ?? null,
          florence_model: removed.has("florence") ? null : current?.florence_model ?? null,
        };
      });
      if (result.unloaded.length === 1) setMessage(`${providerLabel(result.unloaded[0] as "qwen" | "florence")} caption model unloaded. GPU memory released.`);
      else if (result.unloaded.length > 1) setMessage(`AI caption models unloaded (${result.unloaded.map((item) => providerLabel(item as "qwen" | "florence")).join(", ")}). GPU memory released.`);
      else { await refreshCaptionRuntime(); setMessage("No AI caption model was loaded."); }
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to unload AI model"); }
    finally { setUnloading(false); }
  }

  async function saveValidationPolicy() {
    if (!project || !revision || !policyDirty) return;
    setPolicySaving(true); setMessage("");
    try {
      const next = await updateCaptionValidationPolicy(project.id, revision.id, {
        protected_phrases: parsePolicyList(protectedDraft),
        spellcheck_enabled: spellcheckEnabled,
        accepted_words: parsePolicyList(acceptedWordsDraft),
      });
      setPolicy(next);
      setProtectedDraft(next.caption_validation.protected_phrases.join("\n"));
      setAcceptedWordsDraft(next.caption_validation.accepted_words.join("\n"));
      await refreshCaptionStatuses();
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
      setMessage(`${displayName(selectedAsset)} training policy saved.`);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save asset policy"); }
    finally { setPolicySaving(false); }
  }

  function AssetThumb({ asset, compact = false }: { asset: (typeof assets)[number]; compact?: boolean }) {
    const name = displayName(asset);
    return <button className={`caption-nav-card ${compact ? "compact" : ""} ${selectedAsset?.filename === asset.filename ? "selected" : ""}`} onClick={() => selectImage(asset.filename)} title={displayTitle(asset)}>
      <span className="caption-nav-image-shell">
        <img src={imageUrl(asset.filename)} alt={name} />
        <AssetStatusOverlay asset={asset} />
      </span>
      <span className="caption-nav-name">{name}</span>
    </button>;
  }

  if (!project || !revision) return <section className="panel hero-panel stack"><p className="eyebrow">Project required</p><h1>Captions</h1><p className="muted">Open a project and working revision on the Start page first.</p></section>;

  return <div className="stack caption-page">
    <header className="page-header"><div><p className="eyebrow">{project.name} · {revision.name}</p><h1>Captions</h1><p className="muted">Image + caption is the primary project unit. AI assistance is optional; project JSON remains authoritative.</p></div></header>

    <section className="panel stack">
      <div><p className="eyebrow">Caption policy</p><div className="card-title">Identity, validation & protected traits</div><p className="muted">The trigger word and subject grammar are project identity metadata. Protected phrases are traits you want the LoRA to learn rather than repeatedly name; Fizgig flags them instead of silently deleting them.</p></div>
      <div className="caption-trigger-policy caption-identity-policy">
        <label>Trigger word<input value={triggerDraft} onChange={(event) => setTriggerDraft(event.target.value)} placeholder="e.g. sH1VX" spellCheck={false} /></label>
        <label>Subject grammar<select value={subjectGrammar} onChange={(event) => void saveSubjectGrammar(event.target.value)} disabled={grammarSaving}>{Object.entries(grammarProfiles).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
        <div className="caption-trigger-policy-actions">
          <span className={`caption-trigger-policy-help ${triggerPending ? "pending" : ""}`}>{triggerPending ? "Unsaved trigger change. Save it before generating captions that use the trigger." : "Project-level identity. Existing saved captions are never rewritten automatically."}</span>
          <button className="secondary" onClick={saveTriggerWord} disabled={triggerSaving || !triggerPending}>{triggerSaving ? "Saving…" : "Save trigger word"}</button>
        </div>
      </div>
      {!triggerConfigured && <div className="caption-trigger-unset"><strong>No project trigger word is configured.</strong> Baseline Qwen captions can run without one if Add trigger is off; Custom methodologies only require it when their prompt or validation contract uses the trigger.</div>}
      <div className="form-row">
        <label>Protected traits / phrases<textarea value={protectedDraft} onChange={(event) => setProtectedDraft(event.target.value)} placeholder={"blonde hair\nblue eyes"} /><span className="muted">One per line or comma-separated.</span></label>
        <label>Accepted spellings<textarea value={acceptedWordsDraft} onChange={(event) => setAcceptedWordsDraft(event.target.value)} placeholder={"LoKR\nWelsh\nproduct-name"} /><span className="muted">Project dictionary for intentional words spellcheck should ignore. One per line or comma-separated.</span></label>
      </div>
      <div className="actions"><label className="inline-check"><input type="checkbox" checked={spellcheckEnabled} onChange={(event) => setSpellcheckEnabled(event.target.checked)} /> Spellcheck captions</label><button className="secondary" onClick={saveValidationPolicy} disabled={policySaving || !policyDirty}>{policySaving ? "Saving…" : "Save caption policy"}</button></div>
    </section>

    {selectedAsset ? <section className="panel caption-unit-panel">
      <div className="caption-review-heading"><div><p className="eyebrow">Caption review</p><div className="card-title">{selectedDisplayName}</div>{selectedDisplayName !== selectedAsset.filename && <div className="caption-project-filename" title={selectedAsset.filename}>Project file: {selectedAsset.filename}</div>}</div><div className="caption-review-position"><button type="button" className="caption-review-arrow" onClick={() => navigateBy(-1)} disabled={assets.length < 2} aria-label="Previous image">‹</button><span>{selectedIndex + 1} / {assets.length}</span><button type="button" className="caption-review-arrow" onClick={() => navigateBy(1)} disabled={assets.length < 2} aria-label="Next image">›</button></div></div>
      <div className="caption-unit-top">
        <div className="caption-unit-image"><div className="caption-review-canvas"><img src={imageUrl(selectedAsset.filename)} alt={selectedDisplayName} /><AssetStatusOverlay asset={selectedAsset} full /></div></div>
        <div className="caption-unit-copy stack">
          <label className="caption-editor-label">Working Caption<textarea value={captionDraft} spellCheck={spellcheckEnabled} onChange={(event) => { setCaptionDraft(event.target.value); setDraftSource("manual"); setDraftAiMetadata(null); }} /></label>
          <SpellingSummary result={workingSpelling} onReplace={(word, replacement) => { setCaptionDraft((current) => replaceFirstWord(current, word, replacement)); setDraftSource("manual"); setDraftAiMetadata(null); }} />
          <div className="saved-caption-block"><div className="saved-caption-heading"><strong>Saved Project Caption</strong>{captionChanged && <span className="caption-dirty-chip">Unsaved changes</span>}</div><div className={`saved-caption-text ${selectedAsset.caption.trim() ? "" : "empty"}`}>{selectedAsset.caption.trim() || "No saved caption yet."}</div></div>
          {protectedMatches.length > 0 && <div className="notice error">Protected phrase{protectedMatches.length === 1 ? "" : "s"} present: <strong>{protectedMatches.join(", ")}</strong>. Review before training.</div>}
          {message && <div className={message.includes("failed") || message.includes("requires") || message.includes("not configured") || message.includes("Unable") ? "notice error" : "notice success"}>{message}</div>}
          <div className="actions caption-save-actions"><button className="primary" onClick={onSave} disabled={saving || generating || !captionChanged}>{saving ? "Saving…" : "Save Caption"}</button></div>
        </div>
      </div>
      <div className="caption-intervention-row"><div className="caption-intervention-title">Training Intervention <span className="caption-info" title="The loss watcher keeps its real verdict. These policies only control what Fizgig is allowed to do in response.">i</span></div><div className="caption-intervention-controls"><label title="Always Train prevents automatic LR throttling, retirement and exclusion; it does not force the analytic verdict to EASY.">Training Response<select value={selectedPolicy?.training_policy ?? "automatic"} onChange={(event) => setAssetPolicy(event.target.value as AssetTrainingPolicy, undefined)} disabled={policySaving}><option value="automatic">Automatic</option><option value="always_train">Always Train</option></select></label><label title="Hold suppresses automatic rewrites while you experiment manually. Never locks out trainer-initiated rewrites for this policy snapshot.">Auto-Recaption<select value={selectedPolicy?.auto_recaption_policy ?? "automatic"} onChange={(event) => setAssetPolicy(undefined, event.target.value as AutoRecaptionPolicy)} disabled={policySaving}><option value="automatic">Automatic</option><option value="hold">Hold</option><option value="never">Never</option></select></label></div></div>
    </section> : <section className="panel"><p className="muted">No included image selected.</p></section>}

    {selectedAsset && <section className={`panel caption-ai-drawer ${aiOpen ? "open" : ""}`}>
      <button className="caption-ai-toggle" onClick={() => setAiOpen((open) => !open)} aria-expanded={aiOpen}><span><strong>AI Captioning Assistant</strong><span className="muted"> Optional tool — generate a candidate without changing the Working Caption</span></span><span className={`caption-browser-chevron ${aiOpen ? "open" : ""}`}>⌄</span></button>
      {aiOpen && <div className="caption-ai-body stack">
        <div className="caption-ai-primary-controls methodology-caption-controls">
          <label>Captioner<select value={provider} onChange={(event) => { setProvider(event.target.value as "qwen" | "florence"); setAiCandidate(""); setAiCandidateMetadata(null); }}><option value="qwen">{qwenCaptionerLabel}</option><option value="florence">{florenceCaptionerLabel}</option></select></label>
          {provider === "qwen" ? <label>Caption Methodology<select value={methodologyId} onChange={(event) => chooseMethodology(event.target.value)}>
            <optgroup label="Built-in baselines">{methodologies?.builtins.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</optgroup>
            <optgroup label="Custom methodologies">{methodologies?.customs.map((method, index) => <option key={method.id} value={method.id} disabled={!method.configured}>Custom {index + 1} — {method.name}{method.configured ? "" : " (not configured)"}</option>)}</optgroup>
          </select><span className="muted">{activeMethodology?.description}</span></label> : <label>Florence task<select value={florenceTask} onChange={(event) => setFlorenceTask(event.target.value)}>{florenceProvider && "tasks" in florenceProvider ? florenceProvider.tasks.map((task) => <option key={task} value={task}>{task}</option>) : <option value={florenceTask}>{florenceTask}</option>}</select></label>}
          <label className="caption-token-primary">Max Tokens<input type="number" min={16} max={1024} value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></label>
        </div>
        <div className="caption-ai-action-row">
          {provider === "qwen" && customMethodology
            ? <span className="caption-methodology-binding-note">Output behavior is defined by <strong>{activeMethodology?.name}</strong>{customNeedsTrigger ? " · project trigger required" : " · no trigger required"}.</span>
            : <label className="caption-trigger-check inline-check"><input type="checkbox" checked={addTriggerWord && Boolean(triggerWord.trim())} disabled={!triggerWord.trim()} onChange={(event) => setAddTriggerWord(event.target.checked)} /> Add trigger <span className="muted">({triggerWord.trim() || "set above"})</span></label>}
          {provider === "qwen" && <button className="secondary caption-methodology-settings-link" type="button" onClick={() => navigate("/preferences#caption-methodologies")}>Configure methodologies</button>}
          {modelLoaded && <span className="caption-model-loaded-note">Loaded: {captionRuntime?.loaded.map(providerLabel).join(" + ")}</span>}
          <div className="caption-ai-actions caption-ai-actions-primary"><button className="primary" onClick={generateCandidate} disabled={generating || generationBlockedByTrigger}>{generating && !bulkProgress ? "Generating…" : "Generate Candidate"}</button><button className="secondary" onClick={generateMissing} disabled={generating || assets.length === 0 || generationBlockedByTrigger} title={batchGeneratesAll ? "Regenerate every included caption" : `Generate captions for ${missingCount} missing asset${missingCount === 1 ? "" : "s"}`}>{generating && bulkProgress ? bulkProgress : batchGeneratesAll ? "Generate All" : "Generate Missing"}</button><button className="secondary" onClick={unloadAiModel} disabled={generating || unloading || !modelLoaded}>{unloading ? "Unloading…" : "Unload AI model"}</button></div>
        </div>
        {generationBlockedByTrigger && <div className="notice error">{triggerPending ? "Save the pending trigger-word change before generating with this methodology." : "This methodology requires a project trigger word."}</div>}
        <label className="caption-candidate-label">Generated Candidate<textarea value={aiCandidate} spellCheck={spellcheckEnabled} onChange={(event) => setAiCandidate(event.target.value)} placeholder="Generate a candidate to compare with the Working Caption above." /></label>
        <SpellingSummary result={candidateSpelling} />
        {candidateProtectedMatches.length > 0 && <div className="notice error">AI candidate contains protected phrase{candidateProtectedMatches.length === 1 ? "" : "s"}: <strong>{candidateProtectedMatches.join(", ")}</strong>. Review before using it.</div>}
        <div className="caption-candidate-actions"><button className="secondary" disabled={!aiCandidate.trim()} onClick={() => navigator.clipboard?.writeText(aiCandidate)}>Copy Candidate</button><button className="primary" disabled={!aiCandidate.trim()} onClick={() => { setCaptionDraft(aiCandidate); setDraftSource("ai"); setDraftAiMetadata(aiCandidateMetadata); setMessage("AI candidate copied into Working Caption. Save Caption to commit it."); }}>Use as Working Caption</button></div>
        <button className="caption-advanced-toggle" onClick={() => setAdvancedAiOpen((open) => !open)} aria-expanded={advancedAiOpen}><span>Advanced VLM settings</span><span className={`caption-browser-chevron ${advancedAiOpen ? "open" : ""}`}>⌄</span></button>
        {advancedAiOpen && <div className="caption-advanced-panel stack"><div className="muted">Preferences supplies the normal model defaults. These controls are optional model overrides for this captioning session; methodology prompts stay centralized in Preferences.</div>{provider === "qwen" ? <><label>Caption model / checkpoint<input value={qwenModel} onChange={(event) => setQwenModel(event.target.value)} placeholder="Qwen/Qwen3-VL-8B-Instruct or /workspace/models/my-qwen" /></label><div className="form-row"><label>Processor override <span className="muted">Optional</span><input value={qwenProcessor} onChange={(event) => setQwenProcessor(event.target.value)} placeholder="Leave blank to use model source" /></label><label>Revision <span className="muted">Optional</span><input value={qwenRevision} onChange={(event) => setQwenRevision(event.target.value)} placeholder="branch, tag, or commit" /></label></div></> : <label>Florence model<select value={florenceModel} onChange={(event) => setFlorenceModel(event.target.value)}>{florenceProvider && "models" in florenceProvider ? florenceProvider.models.map((model) => <option key={model} value={model}>{model}</option>) : <option value={florenceModel}>{florenceModel}</option>}</select></label>}</div>}
      </div>}
    </section>}

    {assets.length > 0 && <section className="panel caption-navigator stack">
      <button className="caption-browser-toggle" onClick={() => setBrowserOpen((open) => !open)} aria-expanded={browserOpen}><span>{browserOpen ? "Hide asset browser" : `Browse all ${assets.length}`}</span><span className={`caption-browser-chevron ${browserOpen ? "open" : ""}`}>⌄</span></button>
      {browserOpen && <div className="caption-browser"><div className="caption-browser-toolbar"><input placeholder="Search training/project filenames or captions…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="muted">{visibleAssets.length} / {assets.length}</span></div><div className="caption-browser-grid">{browserAssets.map((asset) => <AssetThumb key={asset.filename} asset={asset} />)}</div></div>}
      <div className="caption-carousel-row"><button className="caption-carousel-arrow" onClick={() => navigateBy(-1)} aria-label="Previous asset">‹</button><div className="caption-carousel-strip">{carouselAssets.map((asset) => <AssetThumb key={asset.filename} asset={asset} compact />)}</div><button className="caption-carousel-arrow" onClick={() => navigateBy(1)} aria-label="Next asset">›</button></div>
      <div className="caption-carousel-position"><strong>{selectedIndex + 1}</strong> / {assets.length}<span>← → keyboard navigation</span></div>
    </section>}
  </div>;
}
