export {};

const WORKING_IMAGE_SELECTOR = ".image-prep-v6 .v6-working-image";

function classifyWorkingImage(shell: Element) {
  const image = shell.querySelector("img");
  if (!(image instanceof HTMLImageElement)) return;

  const apply = () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const bounds = (shell as HTMLElement).getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const imageAspect = image.naturalWidth / image.naturalHeight;
    const boxAspect = bounds.width / bounds.height;
    // Only advertise hover-to-fit when the compact cover viewport is materially
    // clipping the prepared image. Small conversion/bucket rounding differences
    // should not create an expand glyph.
    const clipped = Math.abs(Math.log(imageAspect / boxAspect)) > 0.08;
    shell.classList.toggle("v6-preview-needs-fit", clipped);
  };

  if (image.complete) apply();
  else image.addEventListener("load", apply, { once: true });
}

function refreshFaceSelectionControls() {
  const root = document.querySelector(".image-prep-v6");
  if (!root) return;
  const faceSelected = Boolean(root.querySelector(".v6-tool-tabs button:nth-child(2).selected"));
  const headingPrimary = root.querySelector(".v6-working-heading > div:first-child");
  const original = root.querySelector(".v6-face-source-selection");
  const existing = root.querySelector(".v6-working-selection-actions");

  if (!faceSelected || !headingPrimary || !original) {
    existing?.remove();
    return;
  }

  const mode = root.querySelector(".v6-working-heading small");
  if (mode && mode.textContent !== "Multi-select assets") mode.textContent = "Multi-select assets";

  const originals = original.querySelectorAll<HTMLButtonElement>(".micro-action");
  const count = original.querySelector(".selection-count")?.textContent?.trim() || "";
  let controls = existing as HTMLDivElement | null;
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "v6-working-selection-actions";
    const selectAll = document.createElement("button");
    selectAll.type = "button";
    selectAll.className = "micro-action";
    selectAll.textContent = "Select All";
    selectAll.addEventListener("click", () => originals[0]?.click());
    const deselectAll = document.createElement("button");
    deselectAll.type = "button";
    deselectAll.className = "micro-action";
    deselectAll.textContent = "Deselect All";
    deselectAll.addEventListener("click", () => originals[1]?.click());
    const selectionCount = document.createElement("span");
    selectionCount.className = "selection-count";
    controls.append(selectAll, deselectAll, selectionCount);
    headingPrimary.appendChild(controls);
  }

  const proxyButtons = controls.querySelectorAll<HTMLButtonElement>("button");
  if (proxyButtons[0]) proxyButtons[0].disabled = Boolean(originals[0]?.disabled);
  if (proxyButtons[1]) proxyButtons[1].disabled = Boolean(originals[1]?.disabled);
  const proxyCount = controls.querySelector(".selection-count");
  if (proxyCount) proxyCount.textContent = count;
}

function refreshWorkingImages() {
  document.querySelectorAll(WORKING_IMAGE_SELECTOR).forEach(classifyWorkingImage);
  refreshFaceSelectionControls();
}

let scheduled = false;
function scheduleRefresh() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    refreshWorkingImages();
  });
}

function install() {
  scheduleRefresh();
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "class", "disabled"],
  });
  window.addEventListener("resize", scheduleRefresh, { passive: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", install, { once: true });
} else {
  install();
}
