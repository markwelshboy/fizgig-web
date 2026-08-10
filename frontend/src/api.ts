export type DatasetImage = {
  filename: string;
  caption: string;
  has_caption: boolean;
  image_url: string;
};

export type DatasetInfo = {
  id: string;
  path: string;
  image_count: number;
  caption_count: number;
  missing_caption_count: number;
  images: DatasetImage[];
};

export type QwenTask = {
  label: string;
  instruction: string;
  max_tokens: number;
};

export type CaptioningOptions = {
  providers: Array<
    | {
        id: "qwen";
        name: string;
        tasks: Record<string, QwenTask>;
        default_task: string;
        default_model: string;
        default_processor: string;
        default_revision: string;
        supports_instruction_override: true;
        supports_arbitrary_model: true;
      }
    | {
        id: "florence";
        name: string;
        models: string[];
        default_model: string;
        tasks: string[];
        default_task: string;
        supports_instruction_override: false;
      }
  >;
};

export type CaptionGenerateRequest = {
  provider: "qwen" | "florence";
  model?: string;
  model_path?: string;
  processor?: string;
  revision?: string;
  task?: string;
  instruction?: string;
  max_tokens?: number;
  trigger_word?: string;
  add_trigger_word?: boolean;
  save?: boolean;
};

export type Preferences = {
  qwen_caption_model: string;
  qwen_caption_processor: string;
  qwen_caption_revision: string;
  caption_model_dir: string;
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
    } catch {
      // Keep the HTTP status fallback.
    }
    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

export function inspectDataset(path: string) {
  return api<DatasetInfo>("/api/datasets/inspect", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export function saveCaption(datasetId: string, filename: string, caption: string) {
  return api<{ filename: string; caption: string }>(
    `/api/datasets/${datasetId}/captions/${encodeURIComponent(filename)}`,
    {
      method: "PUT",
      body: JSON.stringify({ caption }),
    },
  );
}

export function getCaptioningOptions() {
  return api<CaptioningOptions>("/api/captioning/options");
}

export function generateCaption(datasetId: string, filename: string, request: CaptionGenerateRequest) {
  return api<{ filename: string; caption: string; saved: boolean; provider: string }>(
    `/api/datasets/${datasetId}/captions/${encodeURIComponent(filename)}/generate`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
}

export function unloadCaptionModels() {
  return api<{ unloaded: string[] }>("/api/captioning/unload", { method: "POST" });
}

export function getPreferences() {
  return api<Preferences>("/api/preferences");
}

export function savePreferences(preferences: Preferences) {
  return api<Preferences>("/api/preferences", {
    method: "PUT",
    body: JSON.stringify(preferences),
  });
}

export function downloadQwenModel(args: {
  repo_id: string;
  revision?: string;
  model_dir?: string;
  use_as_qwen_caption_model?: boolean;
}) {
  return api<{ repo_id: string; path: string; selected: boolean }>("/api/models/qwen/download", {
    method: "POST",
    body: JSON.stringify(args),
  });
}
