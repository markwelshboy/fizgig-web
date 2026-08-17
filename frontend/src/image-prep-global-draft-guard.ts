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

function enforceSavedPerImagePreview(root: Element, tool: string) {
  if (!globalDraftDirty || tool !== "Per-image Review") return;

  // Outside Global Preparation, Working Assets always uses the backend prepared
  // preview and therefore represents the last committed global transform. While a
  // global draft exists, use that committed image as the Per-image Review basis so
  // transient global slider changes cannot leak into downstream derivative/review
  // decisions. Crop-box interaction remains live; tonal per-image preview resumes
  // normally once the global draft is committed.
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
  root.classList.toggle("v6-global-draft-dirty", globalDraftDirty && tool !== "Global Preparation");
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
