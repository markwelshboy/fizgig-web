const ROOT = ".image-prep-v6";
let globalDraftDirty = false;
let scheduled = false;

function selectedTool(root: Element) {
  const selected = root.querySelector<HTMLButtonElement>(".v6-tool-tabs button.selected");
  return selected?.textContent?.trim() || "";
}

function updateDirtyState(root: Element) {
  if (selectedTool(root) !== "Global Preparation") return;
  const saveButton = Array.from(root.querySelectorAll<HTMLButtonElement>(".v6-tool-panel button"))
    .find((button) => /Global Preparation/.test(button.textContent || ""));
  if (!saveButton) return;
  globalDraftDirty = !saveButton.disabled && /Save Global Preparation/.test(saveButton.textContent || "");
}

function removeNotice(root: Element) {
  root.querySelector(".v6-global-draft-notice")?.remove();
}

function addNotice(root: Element, tool: string) {
  if (!globalDraftDirty || tool === "Global Preparation") {
    removeNotice(root);
    return;
  }
  const panel = root.querySelector(".v6-tool-panel");
  if (!panel || panel.querySelector(".v6-global-draft-notice")) return;
  const notice = document.createElement("div");
  notice.className = "notice warning v6-global-draft-notice";
  notice.innerHTML = "<strong>Unsaved Global Preparation changes are not applied here.</strong> This tool is using the last saved prepared-image state. Save Global Preparation to update downstream tools.";
  panel.insertBefore(notice, panel.firstChild);
}

function enforceSavedPerImagePreview(root: Element, tool: string) {
  if (!globalDraftDirty || tool !== "Per-image Review") return;

  // The selected Working Assets thumbnail is always sourced from the backend
  // prepared-preview endpoint outside Global Preparation, so it represents the
  // last committed global transform.  Use that image while the global draft is
  // dirty instead of allowing the transient React globalDraft filter to leak into
  // Per-image Review.  Crop-box interaction remains live; tonal per-image preview
  // waits until the global draft is committed, which keeps the evaluation basis
  // unambiguous.
  const prepared = root.querySelector<HTMLImageElement>(".v6-working-card.selected .v6-working-image img");
  const review = root.querySelector<HTMLImageElement>(".v6-tool-panel .position-crop-canvas > img");
  if (!prepared || !review || !prepared.src) return;

  if (review.src !== prepared.src) review.src = prepared.src;
  if (review.style.filter !== "none") review.style.filter = "none";
  review.classList.add("v6-saved-global-preview");
}

function refresh() {
  scheduled = false;
  const root = document.querySelector(ROOT);
  if (!root) return;
  updateDirtyState(root);
  const tool = selectedTool(root);
  addNotice(root, tool);
  enforceSavedPerImagePreview(root, tool);
}

function scheduleRefresh() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(refresh);
}

function install() {
  scheduleRefresh();
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "disabled", "src", "style"],
  });

  // Slider/input events happen before React has committed the updated button state;
  // one RAF lets the component settle before we read whether the global draft is dirty.
  document.addEventListener("input", scheduleRefresh, true);
  document.addEventListener("change", scheduleRefresh, true);
  document.addEventListener("click", scheduleRefresh, true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", install, { once: true });
} else {
  install();
}
