import { useEffect } from "react";
import { ImagePrepWorkbenchPageV4 } from "./ImagePrepWorkbenchPageV4";

/**
 * V5 currently keeps the V4 workbench semantics, with a small presentation layer
 * that makes per-image reset/inheritance behavior explicit while the editor is open.
 */
export function ImagePrepWorkbenchPageV5() {
  useEffect(() => {
    function refineExceptionEditor() {
      const editors = document.querySelectorAll<HTMLElement>("#per-image-v4 .inline-editor-controls");
      editors.forEach((editor) => {
        const isDerivative = Boolean(editor.querySelector("button.danger.secondary"));
        const buttons = Array.from(editor.querySelectorAll<HTMLButtonElement>("button"));
        const reset = buttons.find((button) => button.textContent?.trim() === "Reset" || button.dataset.resetRefined === "true");
        if (reset) {
          reset.dataset.resetRefined = "true";
          reset.textContent = isDerivative ? "Reset additional adjustments" : "Reset to global recipe";
          reset.title = isDerivative
            ? "Remove adjustments made after this derivative was created. The preparation baked into the derivative is retained."
            : "Remove this image-specific exception and return to the saved global image preparation recipe.";
        }

        let note = editor.querySelector<HTMLElement>(".exception-semantics-note");
        if (!note) {
          note = document.createElement("div");
          note.className = "exception-semantics-note";
          const aspectLabel = editor.querySelector("label");
          if (aspectLabel) editor.insertBefore(note, aspectLabel);
          else editor.appendChild(note);
        }

        if (isDerivative) {
          note.innerHTML = "<strong>Derivative adjustment</strong> — this image already contains the preparation that was active when it was created. The sliders below are <span class=\"baked\">additional adjustments</span>. Reset removes only those additions; it cannot restore highlight/detail already lost in the baked derivative.";
        } else {
          note.innerHTML = "<strong>Base Project Asset exception</strong> — the controls begin from the saved global recipe. You can move any value back toward neutral or beyond it for this image only. Reset returns the image to the global recipe.";
        }
      });
    }

    refineExceptionEditor();
    const observer = new MutationObserver(refineExceptionEditor);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return <ImagePrepWorkbenchPageV4 />;
}
