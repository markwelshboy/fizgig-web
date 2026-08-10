import { useEffect } from "react";
import { ImagePrepWorkbenchPageV4 } from "./ImagePrepWorkbenchPageV4";

type ToneValues = {
  exposure: number;
  brightness: number;
  contrast: number;
  gamma: number;
};

function readToneValues(panel: HTMLElement): ToneValues {
  const values: ToneValues = { exposure: 0, brightness: 0, contrast: 0, gamma: 1 };
  for (const label of Array.from(panel.querySelectorAll<HTMLLabelElement>("label.tuning-slider"))) {
    const name = label.querySelector<HTMLElement>(".slider-title span")?.textContent?.trim().toLowerCase();
    const input = label.querySelector<HTMLInputElement>('input[type="range"]');
    if (!name || !input) continue;
    const value = Number(input.value);
    if (name === "exposure") values.exposure = value;
    else if (name === "brightness") values.brightness = value;
    else if (name === "contrast") values.contrast = value;
    else if (name === "gamma") values.gamma = value;
  }
  return values;
}

function sameTone(a: ToneValues, b: ToneValues) {
  return Math.abs(a.exposure - b.exposure) < 1e-6
    && Math.abs(a.brightness - b.brightness) < 1e-6
    && Math.abs(a.contrast - b.contrast) < 1e-6
    && Math.abs(a.gamma - b.gamma) < 1e-6;
}

function brightnessFactor(values: ToneValues) {
  const gammaPreview = Math.pow(1.18, 1 - values.gamma);
  return Math.max(0.001, (1 + values.brightness) * Math.pow(2, values.exposure) * gammaPreview);
}

function contrastFactor(values: ToneValues) {
  return Math.max(0.001, 1 + values.contrast);
}

function baseAssetGrid(root: HTMLElement) {
  const workingPanel = Array.from(root.querySelectorAll<HTMLElement>("section.panel"))
    .find((section) => section.textContent?.includes("Working Assets"));
  if (!workingPanel) return null;

  const heading = Array.from(workingPanel.querySelectorAll<HTMLElement>(".asset-subheading"))[0];
  if (!heading) return null;

  // This terminology belongs inside the project now; these are no longer external source assets.
  const count = heading.querySelector("span");
  const firstNode = heading.childNodes[0];
  if (firstNode) firstNode.textContent = "Base Project Assets ";
  else heading.prepend(document.createTextNode("Base Project Assets "));
  if (count) heading.appendChild(count);

  let candidate = heading.nextElementSibling as HTMLElement | null;
  while (candidate && !candidate.classList.contains("prep-grid")) candidate = candidate.nextElementSibling as HTMLElement | null;
  return candidate;
}

export function ImagePrepWorkbenchPageV5() {
  useEffect(() => {
    let saved: ToneValues | null = null;
    let dirty = false;
    let globalPanel: HTMLElement | null = null;
    let observer: MutationObserver | null = null;

    function root() {
      return document.querySelector<HTMLElement>(".image-prep-v4");
    }

    function findGlobalPanel(page: HTMLElement) {
      return Array.from(page.querySelectorAll<HTMLElement>("section.panel"))
        .find((section) => section.textContent?.includes("Global Image Preparation")) || null;
    }

    function clearPreview(page: HTMLElement) {
      const grid = baseAssetGrid(page);
      if (!grid) return;
      for (const card of Array.from(grid.querySelectorAll<HTMLElement>(".prep-image-card"))) {
        const image = card.querySelector<HTMLImageElement>(".prep-image-wrap img");
        if (image) image.style.removeProperty("filter");
        card.classList.remove("global-draft-preview");
      }
    }

    function applyPreview() {
      const page = root();
      if (!page || !globalPanel || !saved) return;
      const current = readToneValues(globalPanel);
      const grid = baseAssetGrid(page);
      if (!grid) return;

      if (sameTone(current, saved)) {
        clearPreview(page);
        return;
      }

      const brightness = brightnessFactor(current) / brightnessFactor(saved);
      const contrast = contrastFactor(current) / contrastFactor(saved);
      const filter = `brightness(${brightness}) contrast(${contrast})`;

      for (const card of Array.from(grid.querySelectorAll<HTMLElement>(".prep-image-card"))) {
        // Excluded cards deliberately show their unprepared source, so a delta from the saved prepared
        // recipe would be misleading. They will pick the recipe up if re-included.
        if (card.classList.contains("excluded")) continue;
        const image = card.querySelector<HTMLImageElement>(".prep-image-wrap img");
        if (image) image.style.filter = filter;
        card.classList.add("global-draft-preview");
      }
    }

    function wire() {
      const page = root();
      if (!page) return;
      baseAssetGrid(page); // also keeps the heading terminology current after React refreshes.
      const nextPanel = findGlobalPanel(page);
      if (!nextPanel) return;
      if (globalPanel === nextPanel && saved) return;

      observer?.disconnect();
      globalPanel = nextPanel;
      saved = readToneValues(globalPanel);
      dirty = false;

      globalPanel.addEventListener("input", (event) => {
        if (!(event.target instanceof HTMLInputElement) || event.target.type !== "range") return;
        dirty = true;
        requestAnimationFrame(applyPreview);
      });

      observer = new MutationObserver(() => {
        const pageNow = root();
        if (!pageNow || !globalPanel) return;
        baseAssetGrid(pageNow);
        const saveButton = Array.from(globalPanel.querySelectorAll<HTMLButtonElement>("button"))
          .find((button) => button.textContent?.toLowerCase().includes("composition"));
        if (dirty && saveButton?.disabled && saveButton.textContent?.toLowerCase().includes("saved")) {
          saved = readToneValues(globalPanel);
          dirty = false;
          clearPreview(pageNow);
        }
      });
      observer.observe(globalPanel, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
    }

    const frame = requestAnimationFrame(wire);
    const pageObserver = new MutationObserver(() => requestAnimationFrame(wire));
    const content = document.querySelector("main.content");
    if (content) pageObserver.observe(content, { subtree: true, childList: true });

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      pageObserver.disconnect();
      const page = root();
      if (page) clearPreview(page);
    };
  }, []);

  return <ImagePrepWorkbenchPageV4 />;
}
