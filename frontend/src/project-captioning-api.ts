import type { CaptionGenerateRequest } from "./api";

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

export function preparedProjectAssetUrl(projectId: string, revisionId: string, filename: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/prep/assets/${encodeURIComponent(filename)}/prepared-preview`;
}

export function generateProjectAssetCaption(
  projectId: string,
  revisionId: string,
  filename: string,
  request: CaptionGenerateRequest,
) {
  return api<{ filename: string; caption: string; saved: false; provider: string; prepared_asset: true }>(
    `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/captions/${encodeURIComponent(filename)}/generate`,
    { method: "POST", body: JSON.stringify(request) },
  );
}
