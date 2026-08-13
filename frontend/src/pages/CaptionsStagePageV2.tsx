import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CaptionTemplateEditor } from "../components/CaptionTemplateEditor";
import { useSession } from "../session";
import { CaptionsStagePage } from "./CaptionsStagePage";

export function CaptionsStagePageV2() {
  const { project, revision } = useSession();
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const page = document.querySelector(".caption-stage-shell .caption-page");
    const policyPanel = page?.querySelector("section.panel.stack");
    if (!page || !policyPanel) {
      setHost(null);
      return;
    }
    const node = document.createElement("div");
    node.className = "caption-template-portal-host";
    policyPanel.insertAdjacentElement("afterend", node);
    setHost(node);
    return () => {
      setHost(null);
      node.remove();
    };
  }, [project?.id, revision?.id]);

  return <>
    <CaptionsStagePage />
    {host && project && revision && createPortal(
      <CaptionTemplateEditor
        key={`${project.id}:${revision.id}:${project.trigger_word}`}
        projectId={project.id}
        revisionId={revision.id}
      />,
      host,
    )}
  </>;
}
