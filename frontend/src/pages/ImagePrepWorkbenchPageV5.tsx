import { TrainingFilenamePolicyEditor } from "../components/TrainingFilenamePolicyEditor";
import { useSession } from "../session";
import { ImagePrepWorkbenchPageV4 } from "./ImagePrepWorkbenchPageV4";

export function ImagePrepWorkbenchPageV5() {
  const { project, revision } = useSession();
  const assetVersion = revision
    ? `${revision.id}:${revision.assets.filter((asset) => asset.included !== false).map((asset) => asset.id || asset.filename).join(",")}`
    : "none";

  return <div className="stack image-prep-v5-shell">
    <ImagePrepWorkbenchPageV4 />
    {project && revision && <section className="panel stack training-filename-panel">
      <TrainingFilenamePolicyEditor
        projectId={project.id}
        revisionId={revision.id}
        suggestedBasename={project.trigger_word || project.id}
        assetVersion={assetVersion}
      />
    </section>}
  </div>;
}
