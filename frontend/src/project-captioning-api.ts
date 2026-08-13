import { beginLocalActivity, notifyRuntime } from "./activity-api";
import { getCaptionRuntimeStatus } from "./caption-runtime-api";
import type { ProjectCaptionGenerateRequest, ProjectCaptionGenerateResult } from "./caption-template-api";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

function providerLabel(provider: string) {
  return provider === "florence" ? "Florence-2" : "Qwen3-VL";
}

export function preparedProjectAssetUrl(projectId: string, revisionId: string, filename: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/prep/assets/${encodeURIComponent(filename)}/prepared-preview`;
}

export async function generateProjectAssetCaption(
  projectId: string,
  revisionId: string,
  filename: string,
  request: ProjectCaptionGenerateRequest,
) {
  const effectiveRequest: ProjectCaptionGenerateRequest = request.provider === "qwen"
    ? { ...request, use_project_template: true, add_trigger_word: false }
    : request;

  let needsLoad = false;
  try {
    const runtime = await getCaptionRuntimeStatus();
    needsLoad = !runtime.loaded.includes(effectiveRequest.provider as "qwen" | "florence");
  } catch {
    // Runtime status is advisory; generation itself remains the source of truth.
  }

  const label = providerLabel(effectiveRequest.provider);
  if (needsLoad) notifyRuntime(`${label} is not loaded. Downloading/loading the model now…`, "info");
  const endActivity = beginLocalActivity("Captioning", needsLoad ? `Downloading/loading ${label}` : `Generating caption · ${filename}`);
  try {
    return await api<ProjectCaptionGenerateResult>(
      `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/captions/${encodeURIComponent(filename)}/generate`,
      { method: "POST", body: JSON.stringify(effectiveRequest) },
    );
  } finally {
    endActivity();
  }
}
