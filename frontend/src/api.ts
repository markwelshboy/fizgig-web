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
