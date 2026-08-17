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
    // A tiny tolerance avoids showing the affordance for nominally square images
    // that differ only by a pixel or two after format conversion/bucketing.
    const clipped = Math.abs(Math.log(imageAspect / boxAspect)) > 0.025;
    shell.classList.toggle("v6-preview-needs-fit", clipped);
  };

  if (image.complete) apply();
  else image.addEventListener("load", apply, { once: true });
}

function refreshWorkingImages() {
  document.querySelectorAll(WORKING_IMAGE_SELECTOR).forEach(classifyWorkingImage);
}

function install() {
  refreshWorkingImages();
  const observer = new MutationObserver(() => refreshWorkingImages());
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  window.addEventListener("resize", refreshWorkingImages, { passive: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", install, { once: true });
} else {
  install();
}
