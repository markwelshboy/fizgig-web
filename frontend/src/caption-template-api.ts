import type { CaptionGenerateRequest } from "./api";

export type CaptionGrammarProfile = {
  label: string;
  gender_grammar: string;
  subject_pronoun: string;
  object_pronoun: string;
  possessive_pronoun: string;
  reflexive_pronoun: string;
};

export type CaptionTemplateValidation = {
  require_exact_trigger: boolean;
  require_trigger_first: boolean;
  require_single_trigger: boolean;
  reject_detached_trailing_trigger: boolean;
  retry_on_failure: boolean;
  max_attempts: number;
};

export type CaptionTemplateState = {
  schema_version: number;
  revision: string;
  template_id: string;
  template_name: string;
  template_revision: number;
  template_text: string;
  grammar_profile: string;
  validation: CaptionTemplateValidation;
  updated_at?: string | null;
};

export type CaptionTemplatePayload = {
  state: CaptionTemplateState;
  variables: Record<string, string>;
  rendered_instruction: string;
  ready: boolean;
  missing_variables: string[];
  grammar_profiles: Record<string, CaptionGrammarProfile>;
};

export type CaptionTemplateProvenance = {
  template_id: string;
  template_name: string;
  template_revision: number;
  grammar_profile: string;
  variables: Record<string, string>;
  rendered_instruction: string;
  validation: CaptionTemplateValidation;
};

export type ProjectCaptionGenerateRequest = CaptionGenerateRequest & {
  use_project_template?: boolean;
};

export type ProjectCaptionGenerateResult = {
  filename: string;
  caption: string;
  saved: false;
  provider: string;
  prepared_asset: true;
  template?: CaptionTemplateProvenance | null;
  validation?: { valid: boolean; errors: string[]; warnings: string[] } | null;
  attempts?: number;
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

export function getCaptionTemplate(projectId: string, revisionId: string) {
  return request<CaptionTemplatePayload>(`/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/caption-template`);
}

export function previewCaptionTemplate(projectId: string, revisionId: string, values: Partial<Pick<CaptionTemplateState, "grammar_profile" | "template_text" | "validation">>) {
  return request<CaptionTemplatePayload>(`/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/caption-template/preview`, {
    method: "POST",
    body: JSON.stringify({ values }),
  });
}

export function updateCaptionTemplate(projectId: string, revisionId: string, values: Partial<Pick<CaptionTemplateState, "grammar_profile" | "template_text" | "validation">> & { reset_template?: boolean }) {
  return request<CaptionTemplatePayload>(`/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/caption-template`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}
