export type ActivityStatus = {
  busy: boolean;
  label: string;
  detail: string;
  active_count: number;
  elapsed_seconds: number;
};

export async function getActivityStatus(): Promise<ActivityStatus> {
  const response = await fetch("/api/activity");
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<ActivityStatus>;
}
