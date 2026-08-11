import type { SyntheticEvent } from "react";
import { ImagePrepWorkbenchPageV4 } from "./ImagePrepWorkbenchPageV4";

const EXPAND_ASPECT_TOLERANCE = 0.03;

export function ImagePrepWorkbenchPageV5() {
  function markExpandableThumbnail(event: SyntheticEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    const wrapper = target.closest(".prep-image-wrap");
    if (!(wrapper instanceof HTMLElement)) return;

    const ratio = target.naturalWidth / Math.max(1, target.naturalHeight);
    wrapper.classList.toggle("can-expand", Math.abs(ratio - 1) > EXPAND_ASPECT_TOLERANCE);
  }

  return (
    <div onLoadCapture={markExpandableThumbnail}>
      <ImagePrepWorkbenchPageV4 />
    </div>
  );
}
