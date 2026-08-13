export type ActivityStatus = {
  busy: boolean;
  label: string;
  detail: string;
  active_count: number;
  elapsed_seconds: number;
};

export type RuntimeNotification = {
  id: string;
  message: string;
  tone: "info" | "success" | "error";
};

type LocalActivity = {
  token: string;
  label: string;
  detail: string;
  startedAt: number;
};

const localActivities = new Map<string, LocalActivity>();
const listeners = new Set<(status: ActivityStatus) => void>();
const notificationListeners = new Set<(notification: RuntimeNotification) => void>();

function localSnapshot(): ActivityStatus {
  const active = [...localActivities.values()].sort((a, b) => a.startedAt - b.startedAt);
  if (!active.length) return { busy: false, label: "Idle", detail: "", active_count: 0, elapsed_seconds: 0 };
  const current = active[0];
  return {
    busy: true,
    label: current.label,
    detail: current.detail,
    active_count: active.length,
    elapsed_seconds: Math.max(0, (Date.now() - current.startedAt) / 1000),
  };
}

function publishLocalActivity() {
  const snapshot = localSnapshot();
  listeners.forEach((listener) => listener(snapshot));
}

export function beginLocalActivity(label: string, detail = "") {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localActivities.set(token, { token, label, detail, startedAt: Date.now() });
  publishLocalActivity();
  return () => {
    localActivities.delete(token);
    publishLocalActivity();
  };
}

export function subscribeLocalActivity(listener: (status: ActivityStatus) => void) {
  listeners.add(listener);
  listener(localSnapshot());
  return () => listeners.delete(listener);
}

export function notifyRuntime(message: string, tone: RuntimeNotification["tone"] = "info") {
  const notification = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, message, tone };
  notificationListeners.forEach((listener) => listener(notification));
}

export function subscribeRuntimeNotifications(listener: (notification: RuntimeNotification) => void) {
  notificationListeners.add(listener);
  return () => notificationListeners.delete(listener);
}

export async function getActivityStatus(): Promise<ActivityStatus> {
  const response = await fetch("/api/activity");
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<ActivityStatus>;
}
