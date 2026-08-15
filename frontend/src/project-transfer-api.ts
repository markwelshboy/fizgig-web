import type { ProjectInfo } from "./api";

export type ArchiveComponent = {
  id: string;
  label: string;
  group: string;
  description: string;
  dependencies: string[];
  required?: boolean;
  bytes: number;
  file_count: number;
  available: boolean;
  archive_selected?: boolean;
};

export type ArchivePreset = {
  id: "clean" | "standard" | "full" | "exhaustive";
  label: string;
  description: string;
  components: string[];
  identity_mode: "preserve" | "clone";
};

export type ProjectExportOptions = {
  schema_version: number;
  project_id: string;
  components: ArchiveComponent[];
  presets: ArchivePreset[];
};

export type ProjectImportInspection = {
  token: string;
  filename: string;
  kind: string;
  upload_bytes: number;
  created_at: string;
  project: {
    id: string;
    name: string;
    description: string;
    run_count: number;
    dataset_revision_count: number;
  };
  collision: boolean;
  archive_manifest: Record<string, unknown> | null;
  components: ArchiveComponent[];
  presets: ArchivePreset[];
};

async function jsonApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
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

export function getProjectExportOptions(projectId: string) {
  return jsonApi<ProjectExportOptions>(`/api/projects/${encodeURIComponent(projectId)}/export/options`);
}

export function projectArchiveUrl(projectId: string, args: {
  preset: string;
  components: string[];
  identityMode: "preserve" | "clone";
  cloneId?: string;
  cloneName?: string;
}) {
  const params = new URLSearchParams();
  params.set("preset", args.preset);
  params.set("components", args.components.join(","));
  params.set("identity_mode", args.identityMode);
  if (args.cloneId) params.set("clone_id", args.cloneId);
  if (args.cloneName) params.set("clone_name", args.cloneName);
  return `/api/projects/${encodeURIComponent(projectId)}/export?${params.toString()}`;
}

export async function inspectProjectArchive(file: File) {
  const form = new FormData();
  form.append("archive", file);
  return jsonApi<ProjectImportInspection>("/api/projects/import/inspect", { method: "POST", body: form });
}

export function finalizeProjectArchive(args: {
  token: string;
  components: string[];
  identityMode: "preserve" | "clone";
  cloneId?: string;
  cloneName?: string;
}) {
  return jsonApi<ProjectInfo>("/api/projects/import/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: args.token,
      components: args.components,
      identity_mode: args.identityMode,
      clone_id: args.cloneId || null,
      clone_name: args.cloneName || null,
    }),
  });
}
