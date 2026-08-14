export type TrainingModelAsset = {
  key: string;
  label: string;
  repo: string;
  filename: string;
  size_gb: number;
  path: string;
  exists: boolean;
  core: boolean;
};

export type TrainingModelFamilyState = {
  id: "krea2" | "klein" | string;
  name: string;
  ready: boolean;
  support_ready: boolean;
  gated: boolean;
  assets: TrainingModelAsset[];
};

export type TrainingModelState = {
  model_dir: string;
  hf_token_available: boolean;
  families: TrainingModelFamilyState[];
};

export type TrainingModelDownloadJob = {
  id: string;
  kind: string;
  family?: string;
  repo_id?: string;
  model_dir: string;
  status: "queued" | "running" | "complete" | "failed";
  phase: string;
  current_asset?: string | null;
  completed_assets?: number;
  total_assets?: number;
  bytes_done?: number;
  bytes_total?: number;
  log_tail?: string[];
  error?: string | null;
};

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

export function getTrainingModelState() {
  return api<TrainingModelState>("/api/training-models");
}

export function downloadTrainingModelFamily(family: string, modelDir: string) {
  return api<TrainingModelDownloadJob>(`/api/training-models/${encodeURIComponent(family)}/download`, {
    method: "POST",
    body: JSON.stringify({ model_dir: modelDir }),
  });
}

export function getTrainingModelDownload(jobId: string) {
  return api<TrainingModelDownloadJob>(`/api/models/downloads/${encodeURIComponent(jobId)}`);
}
