export type CaptionMethodologyValidation = {
  require_exact_trigger: boolean;
  require_trigger_first: boolean;
  require_single_trigger: boolean;
  reject_detached_trailing_trigger: boolean;
  reject_generic_subject_after_trigger: boolean;
  retry_on_failure: boolean;
  max_attempts: number;
};

export type CaptionMethodology = {
  id: string;
  kind: "builtin" | "custom";
  task?: string;
  name: string;
  description: string;
  instruction: string;
  max_tokens: number;
  trigger_strategy: "legacy_prepend_optional" | "template_variables";
  validation: CaptionMethodologyValidation | null;
  configured: boolean;
  revision: number;
  hash: string;
  updated_at?: string | null;
};

export type CaptionMethodologyPayload = {
  schema_version: number;
  builtins: CaptionMethodology[];
  customs: CaptionMethodology[];
  rewrite_ladder: [string, string, string];
  variables: string[];
  updated_at?: string | null;
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

export function getCaptionMethodologies() {
  return request<CaptionMethodologyPayload>("/api/captioning/methodologies");
}

export function saveCaptionMethodologies(values: {
  customs?: Record<string, Partial<CaptionMethodology>>;
  rewrite_ladder?: string[];
}) {
  return request<CaptionMethodologyPayload>("/api/captioning/methodologies", {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}
