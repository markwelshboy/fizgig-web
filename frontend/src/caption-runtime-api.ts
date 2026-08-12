import type { ProjectInfo } from "./api";

export type CaptionRuntimeStatus = {
  loaded: Array<"qwen" | "florence">;
  qwen_model: string | null;
  florence_model: string | null;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
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

export function getCaptionRuntimeStatus() {
  return request<CaptionRuntimeStatus>("/api/captioning/status");
}

export function updateProjectTriggerWord(projectId: string, triggerWord: string) {
  return request<ProjectInfo>(`/api/projects/${encodeURIComponent(projectId)}/trigger-word`, {
    method: "PUT",
    body: JSON.stringify({ trigger_word: triggerWord }),
  });
}
