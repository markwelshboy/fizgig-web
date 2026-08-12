export type SamplingSeedMode = "fixed" | "increment";
export type SamplingCacheMode = "auto" | "on" | "off";

export type SampleDefinition = {
  id: string;
  prompt_template: string;
  width: number;
  height: number;
  cfg_scale: number;
  seed: number;
};

export type SamplingPlan = {
  schema_version: 1;
  enabled: boolean;
  authoring: {
    seed_mode: SamplingSeedMode;
    seed_value: number;
  };
  schedule: {
    sample_at_start: boolean;
    every_n_epochs: number;
    every_n_steps: number;
  };
  renderer: {
    use_distilled: boolean;
    cache_model: SamplingCacheMode;
    steps: number;
    negative_prompt: string;
    flow_shift: number | null;
  };
  samples: SampleDefinition[];
  updated_at: string | null;
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

export function getSamplingPlan(projectId: string) {
  return request<SamplingPlan>(`/api/projects/${encodeURIComponent(projectId)}/sampling-plan`);
}

export function updateSamplingPlan(projectId: string, plan: SamplingPlan) {
  return request<SamplingPlan>(`/api/projects/${encodeURIComponent(projectId)}/sampling-plan`, {
    method: "PUT",
    body: JSON.stringify(plan),
  });
}
