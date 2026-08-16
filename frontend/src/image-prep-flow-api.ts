import type { ImagePrepState, ProjectInfo, ProjectRevision, TrainingResolutionPolicy } from "./api";

export type SupplementalImageImportResult = {
  project: ProjectInfo;
  revision: ProjectRevision;
  state: ImagePrepState;
  import: { id: string; image_count: number; filenames: string[] };
};

export type ManualCropPreset = {
  id: "trainer" | "half" | "quarter" | string;
  label: string;
  width: number;
  height: number;
  megapixels: number;
  bucket_width: number;
  bucket_height: number;
  resize_required: boolean;
};

export type ManualCropPresetResponse = {
  filename: string;
  aspect_ratio: string;
  source_width: number;
  source_height: number;
  training_resolution: TrainingResolutionPolicy;
  presets: ManualCropPreset[];
};

async function responseError(response: Response) {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    if (body?.detail) detail = body.detail;
  } catch {}
  return new Error(detail);
}

export async function importProjectImages(projectId: string, revisionId: string, files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("images", file);
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/prep/import-images`,
    { method: "POST", body: form },
  );
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<SupplementalImageImportResult>;
}

export async function getManualCropPresets(projectId: string, revisionId: string, filename: string, aspectRatio: string) {
  const query = new URLSearchParams({ filename, aspect_ratio: aspectRatio });
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/prep/manual-crop-presets?${query.toString()}`,
  );
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<ManualCropPresetResponse>;
}
